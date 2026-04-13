/**
 * Version utility - Reads version from package.json
 */

import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createLogger } from "@pegasus/utils";

const logger = createLogger("Version");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedVersion: string | null = null;
let cachedRuntimeInstanceMetadata: RuntimeInstanceMetadata | null = null;

const DEFAULT_VERSION = '0.0.0';
const DEFAULT_PACKAGED_BRANCH = 'release';
const DEFAULT_UNKNOWN_BRANCH = 'unknown';
const DEFAULT_RUNTIME_CHANNEL = 'development';
const BANNER_VALUE_MAX_LENGTH = 120;

type ExistsFn = (path: string) => boolean;
type ReadFileFn = (path: string) => string;
type ExecFileFn = (file: string, args: string[], options: { cwd: string }) => string;

export interface RuntimeInstanceMetadata {
  version: string;
  gitBranch: string | null;
  bannerVersion: string;
  bannerBranch: string;
  isPackagedRelease: boolean;
  runtimeChannel: 'development' | 'packaged';
}

export interface RuntimeInstanceMetadataOptions {
  cwd?: string;
  moduleDir?: string;
  exists?: ExistsFn;
  readFile?: ReadFileFn;
  execFile?: ExecFileFn;
}

function readJsonFile(filePath: string, readFile: ReadFileFn): Record<string, unknown> {
  return JSON.parse(readFile(filePath)) as Record<string, unknown>;
}

function resolveServerPackageJsonPath(moduleDir: string, exists: ExistsFn): string {
  const candidatePaths = [
    // Development via tsx: src/lib -> project root
    join(moduleDir, '..', '..', 'package.json'),
    // Packaged/build output: lib -> server bundle root
    join(moduleDir, '..', 'package.json'),
  ];

  const packageJsonPath = candidatePaths.find((candidate) => exists(candidate));
  if (!packageJsonPath) {
    throw new Error(`package.json not found in any expected location: ${candidatePaths.join(', ')}`);
  }

  return packageJsonPath;
}

function isPegasusRepoRoot(dir: string, exists: ExistsFn, readFile: ReadFileFn): boolean {
  const workspacePath = join(dir, 'pnpm-workspace.yaml');
  const packageJsonPath = join(dir, 'package.json');
  const gitPath = join(dir, '.git');

  if (!exists(packageJsonPath) || !exists(gitPath)) {
    return false;
  }

  if (exists(workspacePath)) {
    return true;
  }

  try {
    const packageJson = readJsonFile(packageJsonPath, readFile);
    return packageJson.name === 'pegasus';
  } catch {
    return false;
  }
}

function findPegasusRepoRoot(
  startPaths: Array<string | undefined>,
  exists: ExistsFn,
  readFile: ReadFileFn
): string | null {
  const visited = new Set<string>();

  for (const startPath of startPaths) {
    if (!startPath) {
      continue;
    }

    let currentDir = startPath;
    while (!visited.has(currentDir)) {
      visited.add(currentDir);

      if (isPegasusRepoRoot(currentDir, exists, readFile)) {
        return currentDir;
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  return null;
}

function resolveGitBranch(repoRoot: string, execFile: ExecFileFn): string | null {
  const attempts: string[][] = [
    ['branch', '--show-current'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
  ];

  for (const args of attempts) {
    try {
      const branch = execFile('git', args, { cwd: repoRoot }).trim();

      if (branch && branch !== 'HEAD') {
        return branch;
      }
    } catch {
      // Ignore git lookup failures and continue to the next strategy.
    }
  }

  return null;
}

export function sanitizeBannerValue(value: string | null | undefined, fallback: string): string {
  const sanitized = (value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BANNER_VALUE_MAX_LENGTH);

  return sanitized || fallback;
}

export function getRuntimeInstanceMetadata(
  options: RuntimeInstanceMetadataOptions = {}
): RuntimeInstanceMetadata {
  const useCache =
    options.cwd === undefined &&
    options.moduleDir === undefined &&
    options.exists === undefined &&
    options.readFile === undefined &&
    options.execFile === undefined;

  if (useCache && cachedRuntimeInstanceMetadata) {
    return cachedRuntimeInstanceMetadata;
  }

  const exists = options.exists ?? ((path: string) => existsSync(path));
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf-8'));
  const execFile =
    options.execFile ??
    ((file: string, args: string[], execOptions: { cwd: string }) =>
      execFileSync(file, args, {
        ...execOptions,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
  const moduleDir = options.moduleDir ?? __dirname;
  const cwd = options.cwd ?? process.cwd();

  try {
    const packageJsonPath = resolveServerPackageJsonPath(moduleDir, exists);
    const packageJson = readJsonFile(packageJsonPath, readFile);
    const version =
      typeof packageJson.version === 'string' && packageJson.version.length > 0
        ? packageJson.version
        : DEFAULT_VERSION;
    const repoRoot = findPegasusRepoRoot(
      [cwd, dirname(packageJsonPath), moduleDir],
      exists,
      readFile
    );
    const gitBranch = repoRoot ? resolveGitBranch(repoRoot, execFile) : null;
    const isPackagedRelease = repoRoot === null;
    const runtimeChannel = isPackagedRelease ? 'packaged' : DEFAULT_RUNTIME_CHANNEL;
    const bannerBranch = sanitizeBannerValue(
      gitBranch,
      isPackagedRelease ? DEFAULT_PACKAGED_BRANCH : DEFAULT_UNKNOWN_BRANCH
    );

    const metadata: RuntimeInstanceMetadata = {
      version,
      gitBranch,
      bannerVersion: sanitizeBannerValue(version, DEFAULT_VERSION),
      bannerBranch,
      isPackagedRelease,
      runtimeChannel,
    };

    if (useCache) {
      cachedRuntimeInstanceMetadata = metadata;
      cachedVersion = metadata.version;
    }

    return metadata;
  } catch (error) {
    logger.warn('Failed to resolve runtime instance metadata:', error);

    const metadata: RuntimeInstanceMetadata = {
      version: DEFAULT_VERSION,
      gitBranch: null,
      bannerVersion: DEFAULT_VERSION,
      bannerBranch: DEFAULT_UNKNOWN_BRANCH,
      isPackagedRelease: false,
      runtimeChannel: DEFAULT_RUNTIME_CHANNEL,
    };

    if (useCache) {
      cachedRuntimeInstanceMetadata = metadata;
      cachedVersion = metadata.version;
    }

    return metadata;
  }
}

/**
 * Get the version from package.json
 * Caches the result for performance
 */
export function getVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  return getRuntimeInstanceMetadata().version;
}
