const { program } = require('npm:commander@^13.1.0');
const { loadPyodide } = require('npm:pyodide@^0.28.0-alpha.2');
const fs = require('./fs');
const path = require('./path');

// Load prepare_env.py
// Change prepare env to require to avoid permissions issues
const { prepareEnvCode }= require('./prepareEnv.js');

program
  .name('pyiodide-sandbox')
  .description('Run Python code in a sandboxed environment using Pyodide')
  .version('1.0.0')
  .option('-c, --code <code>', 'Python code to execute')
  .option('-f, --file <path>', 'Path to Python file to execute')
  .option('-s, --session <string>', 'Session name')
  .option('-d, --sessions-dir <path>', 'Directory to store session files')
  .parse(process.argv);

const options = program.opts();

async function initPyodide(pyodide) {
  const sys = pyodide.pyimport("sys");
  const pathlib = pyodide.pyimport("pathlib");

  const dirPath = "/tmp/pyodide_worker_runner/";
  sys.path.append(dirPath);
  pathlib.Path(dirPath).mkdir();
  pathlib
    .Path(dirPath + "prepare_env.py")
    .write_text(prepareEnvCode);
}

async function runPython(pythonCode) {
  try {
    const pyodide = await loadPyodide();
    await pyodide.loadPackage(['micropip', 'msgpack'], {
      messageCallback: (message) => { },
    });
    await initPyodide(pyodide);
    
    // Determine session directory
    const sessionsDir = options.sessionsDir || process.cwd();
    let sessionMetadata;
    let sessionJsonPath;
    let isExistingSession = false;
      
    
    // Handle session if provided
    if (options.session) {
      const sessionPklPath = path.join(sessionsDir, `${options.session}.pkl`);
      sessionJsonPath = path.join(sessionsDir, `${options.session}.json`);
      isExistingSession = fs.existsSync(sessionPklPath) && fs.existsSync(sessionJsonPath);

      
      // Create session metadata file if it doesn't exist
      if (!isExistingSession) {
        sessionMetadata = {
          created: new Date().toISOString(),
          lastModified: new Date().toISOString(),
          packages: []
        };
        fs.writeFileSync(sessionJsonPath, JSON.stringify(sessionMetadata, null, 2));
      } else {
        // Update metadata for existing session
        sessionMetadata = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
      }
      
      // Load PKL file into pyodide if it exists
      if (fs.existsSync(sessionPklPath)) {
        const sessionData = fs.readFileSync(sessionPklPath);
        pyodide.FS.writeFile(`/${options.session}.pkl`, sessionData);
      }
    }
    // Use micropip to install packages
    const prepare_env = pyodide.pyimport("prepare_env");
    let additionalPackagesToInstall = [];
    if (options.session) {
      additionalPackagesToInstall = [...new Set([...sessionMetadata.packages, "dill"])];
    } else {
      additionalPackagesToInstall = [];
    }
    const installedPackages = await prepare_env.install_imports(pythonCode, additionalPackagesToInstall);

    if (options.session && isExistingSession) {
      // Run session preamble
      await prepare_env.load_session(`/${options.session}.pkl`);
    }
    const packages = installedPackages.map(pkg => pkg.get('package'));
    
    // Update session metadata with installed packages if in a session
    if (options.session) {
      const sessionJsonPath = path.join(sessionsDir, `${options.session}.json`);
      const sessionMetadata = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
      sessionMetadata.lastModified = new Date().toISOString();
      fs.writeFileSync(sessionJsonPath, JSON.stringify(sessionMetadata, null, 2));
    }

    // Run the Python code
    const result = await pyodide.runPythonAsync(pythonCode);

    // Run session postamble if needed
    if (options.session) {
      // Run session preamble
      await prepare_env.dump_session(`/${options.session}.pkl`);
      await prepare_env.dump_result(`/${options.session}_result.json`, result);
      /* update session metadata with installed packages */
      sessionMetadata.packages = [...new Set([...sessionMetadata.packages, ...packages])];
      sessionMetadata.lastModified = new Date().toISOString();
      fs.writeFileSync(sessionJsonPath, JSON.stringify(sessionMetadata, null, 2));
      
      // Save session file back to host machine
      const sessionData = pyodide.FS.readFile(`/${options.session}.pkl`);
      const sessionPklPath = path.join(sessionsDir, `${options.session}.pkl`);
      fs.writeFileSync(sessionPklPath, sessionData);

      const resultData = pyodide.FS.readFile(`/${options.session}_result.json`);
      const resultJsonPath = path.join(sessionsDir, `${options.session}_result.json`);
      fs.writeFileSync(resultJsonPath, resultData);
    }

    return { success: true, result };
  } catch (error) {
    console.error('Error executing Python code:');
    console.error(error);
    return { success: false, error: error.message };
  }
}

async function main() {
  if (!options.code && !options.file) {
    console.error('Error: You must provide Python code using either -c/--code or -f/--file option.');
    program.help();
    return;
  }
  
  // Validate session ID if provided
  if (options.session) {
    const validSessionIdRegex = /^[a-zA-Z0-9_-]+$/;
    if (!validSessionIdRegex.test(options.session)) {
      console.error('Error: Session ID must only contain letters, numbers, underscores, and hyphens.');
      process.exit(1);
    }
  }
  
  // Ensure sessions directory exists if specified
  if (options.sessionsDir) {
    try {
      if (!fs.existsSync(options.sessionsDir)) {
        fs.mkdirSync(options.sessionsDir, { recursive: true });
        console.log(`Created sessions directory: ${options.sessionsDir}`);
      }
    } catch (error) {
      console.error(`Error creating sessions directory: ${error.message}`);
      process.exit(1);
    }
  }
  
  let pythonCode = '';
  
  if (options.file) {
    try {
      const filePath = path.resolve(process.cwd(), options.file);
      pythonCode = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      console.error(`Error reading file ${options.file}:`, error.message);
      process.exit(1);
    }
  } else {
    // Replace escaped newlines with actual newlines
    pythonCode = options.code.replace(/\\n/g, '\n');
  }
  
  await runPython(pythonCode);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
