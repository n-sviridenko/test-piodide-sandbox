import { loadPyodide } from "npm:pyodide@^0.28.0-alpha.2";
import { join } from "jsr:@std/path@^1.0.8";
import { parseArgs } from "jsr:/@std/cli@^1.0.16/parse-args";

// Python environment preparation code
const prepareEnvCode = `
import importlib
import sys
from typing import Union, TypedDict, List, Any
import json
import datetime


try:
    from pyodide.code import find_imports  # noqa
except ImportError:
    from pyodide import find_imports  # noqa

import pyodide_js  # noqa

sys.setrecursionlimit(400)


class InstallEntry(TypedDict):
    module: str
    package: str


def find_imports_to_install(imports: list[str]) -> list[InstallEntry]:
    """
    Given a list of module names being imported, return a list of dicts
    representing the packages that need to be installed to import those modules.
    The returned list will only contain modules that aren't already installed.
    Each returned dict has the following keys:
      - module: the name of the module being imported
      - package: the name of the package that needs to be installed
    """
    try:
        to_package_name = pyodide_js._module._import_name_to_package_name.to_py()
    except AttributeError:
        to_package_name = pyodide_js._api._import_name_to_package_name.to_py()

    to_install: list[InstallEntry] = []
    for module in imports:
        try:
            importlib.import_module(module)
        except ModuleNotFoundError:
            to_install.append(
                dict(
                    module=module,
                    package=to_package_name.get(module, module),
                )
            )
    return to_install


async def install_imports(
    source_code_or_imports: Union[str, list[str]],
    additional_packages: list[str] = [],
) -> List[InstallEntry]:
    if isinstance(source_code_or_imports, str):
        try:
            imports: list[str] = find_imports(source_code_or_imports)
        except SyntaxError:
            return
    else:
        imports: list[str] = source_code_or_imports

    to_install = find_imports_to_install(imports)
    # Merge with additional packages
    for package in additional_packages:
        if package not in to_install:
            to_install.append(dict(module=package, package=package))

    if to_install:
        try:
            import micropip  # noqa
        except ModuleNotFoundError:
            micropip_entry = dict(module="micropip", package="micropip")
            await pyodide_js.loadPackage("micropip")
            import micropip  # noqa

        for entry in to_install:
            await micropip.install(entry["package"])
    return to_install


def load_session(path: str) -> List[str]:
    """Load the session module."""
    import dill

    dill.session.load_session(filename=path)


def dump_session(path: str) -> None:
    """Dump the session module."""
    import dill

    dill.session.dump_session(filename=path)


def robust_serialize(obj):
    """Recursively converts an arbitrary Python object into a JSON-serializable structure.

    The function handles:
      - Primitives: str, int, float, bool, None are returned as is.
      - Lists and tuples: Each element is recursively processed.
      - Dictionaries: Keys are converted to strings (if needed) and values are recursively processed.
      - Sets: Converted to lists.
      - Date and datetime objects: Converted to their ISO format strings.
      - For unsupported/unknown objects, a dictionary containing a 'type'
        indicator and the object's repr is returned.
    """
    # Base case: primitives that are already JSON-serializable
    if isinstance(obj, (str, int, float, bool, type(None))):
        return obj

    # Process lists or tuples recursively.
    if isinstance(obj, (list, tuple)):
        return [robust_serialize(item) for item in obj]

    # Process dictionaries.
    if isinstance(obj, dict):
        # Convert keys to strings if necessary and process values recursively.
        return {str(key): robust_serialize(value) for key, value in obj.items()}

    # Process sets by converting them to lists.
    if isinstance(obj, (set, frozenset)):
        return [robust_serialize(item) for item in obj]

    # Process known datetime objects.
    if isinstance(obj, (datetime.date, datetime.datetime)):
        return obj.isoformat()

    # Fallback: for objects that are not directly serializable,
    # return a dictionary with type indicator and repr.
    return {"type": "not serializable", "repr": repr(obj)}


def dump_result(path: str, result: Any) -> List[str]:
    """Get the result of the session."""
    with open(path, "w") as f:
        result = robust_serialize(result)
        json.dump(result, f)
`;

interface SessionMetadata {
  created: string;
  lastModified: string;
  packages: string[];
}

interface PyodideResult {
  success: boolean;
  result?: any;
  error?: string;
}

async function initPyodide(pyodide: any): Promise<void> {
  const sys = pyodide.pyimport("sys");
  const pathlib = pyodide.pyimport("pathlib");

  const dirPath = "/tmp/pyodide_worker_runner/";
  sys.path.append(dirPath);
  pathlib.Path(dirPath).mkdir();
  pathlib.Path(dirPath + "prepare_env.py").write_text(prepareEnvCode);
}

async function runPython(
  pythonCode: string,
  options: {
    session?: string;
    sessionsDir?: string;
  }
): Promise<PyodideResult> {
  try {
    const pyodide = await loadPyodide();
    await pyodide.loadPackage(["micropip", "msgpack"], {
      messageCallback: (message: string) => {},
    });
    await initPyodide(pyodide);

    // Determine session directory
    const sessionsDir = options.sessionsDir || Deno.cwd();
    let sessionMetadata: SessionMetadata = {
      created: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      packages: [],
    };
    let sessionJsonPath: string;
    let isExistingSession = false;

    // Handle session if provided
    if (options.session) {
      const sessionPklPath = join(sessionsDir, `${options.session}.pkl`);
      sessionJsonPath = join(sessionsDir, `${options.session}.json`);

      try {
        // Check if session files exist
        const pklStat = await Deno.stat(sessionPklPath);
        const jsonStat = await Deno.stat(sessionJsonPath);
        isExistingSession = pklStat.isFile && jsonStat.isFile;
      } catch (error) {
        // Files don't exist, isExistingSession remains false
        isExistingSession = false;
      }

      // Create session metadata file if it doesn't exist
      if (!isExistingSession) {
        sessionMetadata = {
          created: new Date().toISOString(),
          lastModified: new Date().toISOString(),
          packages: [],
        };
        await Deno.writeTextFile(
          sessionJsonPath,
          JSON.stringify(sessionMetadata, null, 2)
        );
      } else {
        // Update metadata for existing session
        const jsonContent = await Deno.readTextFile(sessionJsonPath);
        sessionMetadata = JSON.parse(jsonContent);
      }

      // Load PKL file into pyodide if it exists
      try {
        const sessionData = await Deno.readFile(sessionPklPath);
        pyodide.FS.writeFile(`/${options.session}.pkl`, sessionData);
      } catch (error) {
        // File doesn't exist or can't be read, skip loading
      }
    }

    // Use micropip to install packages
    const prepare_env = pyodide.pyimport("prepare_env");
    const additionalPackagesToInstall = options.session
      ? [...new Set([...(sessionMetadata as SessionMetadata).packages, "dill"])]
      : [];

    const installedPackages = await prepare_env.install_imports(
      pythonCode,
      additionalPackagesToInstall
    );

    if (options.session && isExistingSession) {
      // Run session preamble
      await prepare_env.load_session(`/${options.session}.pkl`);
    }

    const packages = installedPackages.map((pkg: any) => pkg.get("package"));

    // Update session metadata with installed packages if in a session
    if (options.session) {
      const sessionJsonPath = join(sessionsDir, `${options.session}.json`);
      const jsonContent = await Deno.readTextFile(sessionJsonPath);
      sessionMetadata = JSON.parse(jsonContent);
      sessionMetadata.lastModified = new Date().toISOString();
      await Deno.writeTextFile(
        sessionJsonPath,
        JSON.stringify(sessionMetadata, null, 2)
      );
    }

    // Run the Python code
    const result = await pyodide.runPythonAsync(pythonCode);

    // Run session postamble if needed
    if (options.session) {
      // Save session state
      await prepare_env.dump_session(`/${options.session}.pkl`);
      await prepare_env.dump_result(`/${options.session}_result.json`, result);

      // Update session metadata with installed packages
      sessionMetadata.packages = [
        ...new Set([...sessionMetadata.packages, ...packages]),
      ];
      sessionMetadata.lastModified = new Date().toISOString();
      await Deno.writeTextFile(
        sessionJsonPath as string,
        JSON.stringify(sessionMetadata, null, 2)
      );

      // Save session file back to host machine
      const sessionData = pyodide.FS.readFile(`/${options.session}.pkl`);
      const sessionPklPath = join(sessionsDir, `${options.session}.pkl`);
      await Deno.writeFile(sessionPklPath, sessionData);

      const resultData = pyodide.FS.readFile(`/${options.session}_result.json`);
      const resultJsonPath = join(
        sessionsDir,
        `${options.session}_result.json`
      );
      await Deno.writeFile(resultJsonPath, resultData);
    }

    return { success: true, result };
  } catch (error: any) {
    console.error("Error executing Python code:");
    console.error(error);
    return { success: false, error: error.message };
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: ["code", "file", "session", "sessions-dir"],
    alias: {
      c: "code",
      f: "file",
      s: "session",
      d: "sessions-dir",
      h: "help",
      V: "version"
    },
    boolean: ["help", "version"],
    default: { 
      help: false,
      version: false
    }
  });

  if (flags.help) {
    console.log(`
pyiodide-sandbox v0.0.6
Run Python code in a sandboxed environment using Pyodide

OPTIONS:
  -c, --code <code>            Python code to execute
  -f, --file <path>            Path to Python file to execute
  -s, --session <string>       Session name
  -d, --sessions-dir <path>    Directory to store session files
  -h, --help                   Display help
  -V, --version                Display version
`);
    return;
  }

  if (flags.version) {
    console.log("pyiodide-sandbox v0.0.6");
    return;
  }

  const options = {
    code: flags.code,
    file: flags.file,
    session: flags.session,
    sessionsDir: flags["sessions-dir"]
  };

  if (!options.code && !options.file) {
    console.error(
      "Error: You must provide Python code using either -c/--code or -f/--file option."
    );
    console.log(`Use --help for usage information.`);
    Deno.exit(1);
  }

  // Validate session ID if provided
  if (options.session) {
    const validSessionIdRegex = /^[a-zA-Z0-9_-]+$/;
    if (!validSessionIdRegex.test(options.session)) {
      console.error(
        "Error: Session ID must only contain letters, numbers, underscores, and hyphens."
      );
      Deno.exit(1);
    }
  }

  // Ensure sessions directory exists if specified
  if (options.sessionsDir) {
    try {
      try {
        const dirInfo = await Deno.stat(options.sessionsDir);
        if (!dirInfo.isDirectory) {
          throw new Error(
            `Path exists but is not a directory: ${options.sessionsDir}`
          );
        }
      } catch (error) {
        // Directory doesn't exist, create it
        if (error instanceof Deno.errors.NotFound) {
          await Deno.mkdir(options.sessionsDir, { recursive: true });
          console.log(`Created sessions directory: ${options.sessionsDir}`);
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      console.error(`Error creating sessions directory: ${error.message}`);
      Deno.exit(1);
    }
  }

  let pythonCode = "";

  if (options.file) {
    try {
      const filePath = options.file.startsWith("/")
        ? options.file
        : join(Deno.cwd(), options.file);
      pythonCode = await Deno.readTextFile(filePath);
    } catch (error: any) {
      console.error(`Error reading file ${options.file}:`, error.message);
      Deno.exit(1);
    }
  } else {
    // Replace escaped newlines with actual newlines
    pythonCode = options.code.replace(/\\n/g, "\n");
  }

  const result = await runPython(pythonCode, {
    session: options.session,
    sessionsDir: options.sessionsDir,
  });

  if (!result.success) {
    Deno.exit(1);
  }
}

// If this module is run directly
if (import.meta.main) {
  // Override the global environment variables that Deno's permission prompts look for
  // to suppress color-related permission prompts
  main().catch((err) => {
    console.error("Unhandled error:", err);
    Deno.exit(1);
  });
}

export { runPython };
