"""Prepare the environment for Pyodide.

Adapted from:
https://github.com/alexmojaki/pyodide-worker-runner/blob/master/lib/pyodide_worker_runner.py
"""

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
