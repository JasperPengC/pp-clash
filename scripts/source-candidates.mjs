// Read the prospective source set without changing Git's index or following external links.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export function repositoryRoot() {
  return fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trimEnd());
}

export function gitFiles(root, args) {
  return execFileSync('git', ['ls-files', '-z', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

export function sourceCandidates(root) {
  return [...new Set(gitFiles(root, ['--cached', '--others', '--exclude-standard']))].sort();
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function inspectCandidate(root, file) {
  const absolute = path.join(root, file);
  let info;
  try {
    info = fs.lstatSync(absolute);
  } catch (error) {
    // Tracked files deleted from the worktree are not part of the prospective source.
    if (error.code === 'ENOENT') return { deleted: true };
    return { rejection: '无法检查候选文件' };
  }
  try {
    if (info.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
        return { rejection: '绝对路径符号链接' };
      }
      if (!inside(root, path.resolve(path.dirname(absolute), target))) {
        return { rejection: '指向仓库外部的符号链接' };
      }
    }
    // Check ancestors too: a tracked directory may have been replaced with a symlink.
    const resolved = fs.realpathSync(absolute);
    if (!inside(root, resolved)) return { rejection: '指向仓库外部的符号链接' };
    info = fs.statSync(resolved);
    if (!info.isFile()) return { rejection: '非常规源码文件' };
    if (info.size >= MAX_SOURCE_BYTES) return { rejection: '文件达到 50 MiB 源码上限' };
    return { absolute: resolved };
  } catch {
    return { rejection: '无法解析或读取候选文件' };
  }
}

export function displayPath(file) {
  return file.replace(/[\u0000-\u001f\u007f]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
