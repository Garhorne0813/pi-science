/** Host environment variables that must not leak into managed Python, Conda,
 * Micromamba, or Jupyter processes. Matching is case-insensitive for Windows. */
export function isInheritedRuntimeState(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized === "VIRTUAL_ENV"
    || normalized === "UV_PROJECT_ENVIRONMENT"
    || normalized === "PIP_REQUIRE_VIRTUALENV"
    || normalized === "PI_SCIENCE_PYTHON_EXECUTABLE"
    || normalized === "PYTHONHOME"
    || normalized === "PIP_PREFIX"
    || normalized === "CONDA_DEFAULT_ENV"
    || normalized === "CONDA_EXE"
    || normalized === "CONDA_PYTHON_EXE"
    || normalized === "CONDA_SHLVL"
    || normalized === "CONDA_PROMPT_MODIFIER"
    || normalized === "CONDARC"
    || normalized === "CONDA_CHANNELS"
    || normalized === "CONDA_DEFAULT_CHANNELS"
    || normalized === "CONDA_SUBDIR"
    || normalized === "CONDA_PKGS_DIRS"
    || normalized === "CONDA_BLD_PATH"
    || normalized === "MAMBA_ROOT_PREFIX"
    || normalized === "MAMBA_EXE"
    || normalized === "MAMBA_NO_RC"
    || normalized === "MAMBARC"
    || /^CONDA_PREFIX(?:_\d+)?$/.test(normalized);
}

export function sanitizeRuntimeEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => !isInheritedRuntimeState(key)));
}
