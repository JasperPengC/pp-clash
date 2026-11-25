#!/usr/bin/env node
import { displayPath, gitFiles, inspectCandidate, repositoryRoot, sourceCandidates } from './source-candidates.mjs';

const root = repositoryRoot();
// A forced add must not bypass the repository's private-file exclusions.
const excluded = new Set(gitFiles(root, ['--cached', '--ignored', '--exclude-standard']));
const productDocuments = new Set(['README.md', 'README.zh-CN.md', 'THIRD_PARTY_NOTICES.md', 'scripts/release-notes.md']);
const rejected = [];

for (const file of sourceCandidates(root)) {
  const candidate = inspectCandidate(root, file);
  if (candidate.deleted) continue;
  const reason = excluded.has(file) ? '被忽略的本地文件已被强制跟踪'
    : /\.md$/i.test(file) && !productDocuments.has(file) ? '非公开产品文档'
      : candidate.rejection;
  if (reason) rejected.push(`${displayPath(file)}: ${reason}`);
}

if (rejected.length) {
  console.error('公开文件检查未通过（请保留本地文件，仅取消不应公开文件的 Git 跟踪）：');
  rejected.forEach(file => console.error(`  ${file}`));
  process.exitCode = 1;
} else {
  console.log('公开文件检查通过：已检查跟踪文件与未忽略的新文件。');
}
