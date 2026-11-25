#!/usr/bin/env node
// Print locations only; secret values and source lines must never enter CI logs.
import fs from 'node:fs';
import path from 'node:path';
import { displayPath, inspectCandidate, repositoryRoot, sourceCandidates } from './source-candidates.mjs';

const root = repositoryRoot();
const sensitiveName = /^(?:\.env(?:$|\.)|.*\.(?:pem|key|p12|pfx|cer|crt|mobileprovision|keystore|jks|ovpn)$)/i;
const secret = /ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/;
const rejected = [];

for (const file of sourceCandidates(root)) {
  const candidate = inspectCandidate(root, file);
  if (candidate.deleted) continue;
  const display = displayPath(file);
  const name = path.posix.basename(file);
  if (name !== '.env.example' && sensitiveName.test(name)) {
    rejected.push(`${display}: 敏感文件名`);
  }
  if (candidate.rejection) {
    rejected.push(`${display}: ${candidate.rejection}`);
    continue;
  }
  try {
    const lines = fs.readFileSync(candidate.absolute, 'utf8').split(/\r\n|\n|\r/);
    lines.forEach((line, index) => {
      if (secret.test(line)) rejected.push(`${display}:${index + 1}`);
    });
  } catch {
    rejected.push(`${display}: 无法读取候选文件`);
  }
}

if (rejected.length) {
  console.error('敏感信息扫描未通过：仅列出候选文件路径与行号，请移除秘密或取消跟踪。');
  rejected.forEach(location => console.error(`  ${location}`));
  process.exitCode = 1;
} else {
  console.log('敏感信息扫描通过：已检查跟踪文件与未忽略的新文件。');
}
