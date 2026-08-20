import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ShellKind = 'auto' | 'bash' | 'powershell';

export interface ShellCommandOptions {
  command: string;
  root: string;
  workdir?: string;
  shell?: ShellKind;
  timeoutMs?: number;
  maxTimeoutMs?: number;
}

export interface ShellCommandResult {
  shell: Exclude<ShellKind, 'auto'>;
  workdir: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface PatchOperation {
  kind: 'add' | 'update' | 'delete';
  filePath: string;
  moveTo?: string;
  lines: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await access(current, constants.F_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Cannot resolve an existing parent for: ${candidate}`);
      current = parent;
    }
  }
}

async function resolveInsideRoot(root: string, requestedPath: string, mustBeDirectory = false): Promise<string> {
  const resolvedRoot = await realpath(path.resolve(root));
  const candidate = path.resolve(resolvedRoot, requestedPath);
  if (!isWithin(resolvedRoot, candidate)) {
    throw new Error(`Path is outside the configured shell root: ${requestedPath}`);
  }

  const existing = await nearestExistingPath(candidate);
  const realExisting = await realpath(existing);
  if (!isWithin(resolvedRoot, realExisting)) {
    throw new Error(`Path resolves outside the configured shell root: ${requestedPath}`);
  }

  if (mustBeDirectory) {
    const info = await stat(candidate);
    if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${requestedPath}`);
  }
  return candidate;
}

function selectShell(shell: ShellKind): { kind: Exclude<ShellKind, 'auto'>; executable: string; args: string[] } {
  const selected = shell === 'auto' ? (process.platform === 'win32' ? 'powershell' : 'bash') : shell;
  if (selected === 'powershell') {
    return {
      kind: selected,
      executable: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    };
  }
  return { kind: selected, executable: 'bash', args: ['-lc'] };
}

export async function runShellCommand(options: ShellCommandOptions): Promise<ShellCommandResult> {
  if (!options.command.trim()) throw new Error('"command" parameter is required.');
  if (options.shell && !['auto', 'bash', 'powershell'].includes(options.shell)) {
    throw new Error('"shell" must be one of: auto, bash, powershell.');
  }

  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > maxTimeoutMs) {
    throw new Error(`"timeout_ms" must be between 100 and ${maxTimeoutMs}.`);
  }

  const workdir = await resolveInsideRoot(options.root, options.workdir || '.', true);
  const shell = selectShell(options.shell ?? 'auto');

  return await new Promise<ShellCommandResult>((resolve, reject) => {
    const child = spawn(shell.executable, [...shell.args, options.command], {
      cwd: workdir,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      if (target === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Unable to start ${shell.kind}: ${error.message}`));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stderr += `\nOutput exceeded the ${MAX_OUTPUT_BYTES}-byte limit and the process was stopped.`;
      }
      resolve({ shell: shell.kind, workdir, exitCode, stdout, stderr, timedOut });
    });
  });
}

function parsePatch(patchText: string): PatchOperation[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch') throw new Error('Patch must start with "*** Begin Patch".');

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length && lines[index] !== '*** End Patch') {
    const header = lines[index++];
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(header);
    if (!match) throw new Error(`Invalid patch operation header: ${header}`);

    const operation: PatchOperation = {
      kind: match[1].toLowerCase() as PatchOperation['kind'],
      filePath: match[2],
      lines: [],
    };
    if (operation.kind === 'update' && lines[index]?.startsWith('*** Move to: ')) {
      operation.moveTo = lines[index++].slice('*** Move to: '.length);
    }
    while (index < lines.length && !lines[index].startsWith('*** Add File: ') &&
      !lines[index].startsWith('*** Update File: ') && !lines[index].startsWith('*** Delete File: ') &&
      lines[index] !== '*** End Patch') {
      operation.lines.push(lines[index++]);
    }
    operations.push(operation);
  }

  if (lines[index] !== '*** End Patch') throw new Error('Patch must end with "*** End Patch".');
  if (operations.length === 0) throw new Error('Patch contains no file operations.');
  return operations;
}

function findSequence(haystack: string[], needle: string[], start: number): number {
  if (needle.length === 0) return start;
  for (let index = start; index <= haystack.length - needle.length; index++) {
    if (needle.every((line, offset) => haystack[index + offset] === line)) return index;
  }
  return -1;
}

function applyUpdate(original: string, patchLines: string[], filePath: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = original.endsWith('\n');
  let fileLines = original.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) fileLines.pop();
  let cursor = 0;
  let index = 0;
  let sawHunk = false;

  while (index < patchLines.length) {
    if (!patchLines[index].startsWith('@@')) {
      if (patchLines[index] === '') { index++; continue; }
      throw new Error(`Expected "@@" hunk header while updating ${filePath}.`);
    }
    sawHunk = true;
    index++;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (index < patchLines.length && !patchLines[index].startsWith('@@')) {
      const line = patchLines[index++];
      if (!line || ![' ', '+', '-'].includes(line[0])) {
        throw new Error(`Invalid hunk line while updating ${filePath}: ${line}`);
      }
      const content = line.slice(1);
      if (line[0] !== '+') oldLines.push(content);
      if (line[0] !== '-') newLines.push(content);
    }

    let matchAt = findSequence(fileLines, oldLines, cursor);
    if (matchAt < 0) matchAt = findSequence(fileLines, oldLines, 0);
    if (matchAt < 0) throw new Error(`Could not find patch context in ${filePath}.`);
    fileLines.splice(matchAt, oldLines.length, ...newLines);
    cursor = matchAt + newLines.length;
  }

  if (!sawHunk) throw new Error(`Update for ${filePath} contains no hunks.`);
  return fileLines.join(eol) + (trailingNewline ? eol : '');
}

export async function applyFilePatch(root: string, patchText: string): Promise<string[]> {
  const operations = parsePatch(patchText);
  const prepared: Array<PatchOperation & { source: string; destination?: string; content?: string }> = [];
  const claimedPaths = new Set<string>();

  for (const operation of operations) {
    const source = await resolveInsideRoot(root, operation.filePath);
    const destination = operation.moveTo ? await resolveInsideRoot(root, operation.moveTo) : undefined;
    for (const claimedPath of [source, destination].filter((value): value is string => Boolean(value))) {
      const key = process.platform === 'win32' ? claimedPath.toLowerCase() : claimedPath;
      if (claimedPaths.has(key)) throw new Error(`A patch may only operate on each path once: ${claimedPath}`);
      claimedPaths.add(key);
    }
    if (destination) {
      try {
        await access(destination);
        throw new Error(`Cannot move file because the destination already exists: ${operation.moveTo}`);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (operation.kind === 'add') {
      try {
        await access(source);
        throw new Error(`Cannot add file because it already exists: ${operation.filePath}`);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (operation.lines.some((line) => !line.startsWith('+'))) {
        throw new Error(`Every content line for an added file must start with "+": ${operation.filePath}`);
      }
      prepared.push({ ...operation, source, content: operation.lines.map((line) => line.slice(1)).join('\n') + '\n' });
      continue;
    }

    const original = await readFile(source, 'utf8');
    if (operation.kind === 'delete') {
      if (operation.lines.some((line) => line !== '')) throw new Error(`Delete operation must not contain content: ${operation.filePath}`);
      prepared.push({ ...operation, source });
    } else {
      prepared.push({ ...operation, source, destination, content: applyUpdate(original, operation.lines, operation.filePath) });
    }
  }

  const changed: string[] = [];
  for (const operation of prepared) {
    if (operation.kind === 'delete') {
      await rm(operation.source);
      changed.push(`deleted ${operation.filePath}`);
    } else {
      await mkdir(path.dirname(operation.source), { recursive: true });
      await writeFile(operation.source, operation.content!, 'utf8');
      if (operation.destination) {
        await mkdir(path.dirname(operation.destination), { recursive: true });
        await rename(operation.source, operation.destination);
        changed.push(`moved ${operation.filePath} -> ${operation.moveTo}`);
      } else {
        changed.push(`${operation.kind === 'add' ? 'added' : 'updated'} ${operation.filePath}`);
      }
    }
  }
  return changed;
}
