import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const postsDir = join(__dirname, '..', 'src', 'content', 'posts');

const files = readdirSync(postsDir).filter(f => f.endsWith('.md'));

const results = [];

for (const file of files) {
  const content = readFileSync(join(postsDir, file), 'utf-8');
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
  if (!bodyMatch) {
    results.push({ file, issue: 'No body found' });
    continue;
  }

  const body = bodyMatch[1].trim();
  const lines = body.split('\n');
  const wordCount = body.split(/\s+/).length;

  const issues = [];

  // Check last non-empty line
  let lastLine = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastLine = lines[i].trim();
      break;
    }
  }

  if (lastLine) {
    const endsProperly = /[.?!")}\]]$/.test(lastLine);
    const endsMidWord = /[a-zA-Z]$/.test(lastLine) && !endsProperly;
    if (!endsProperly || endsMidWord) {
      issues.push(`Last line doesn't end with punctuation: "...${lastLine.slice(-60)}"`);
    }
  }

  if (wordCount < 500) {
    issues.push(`Short body: ${wordCount} words`);
  }

  if (issues.length > 0) {
    results.push({ file, wordCount, issues: issues.join('; ') });
    console.log(`\n\x1b[31m⚠ ${file}\x1b[0m (${wordCount} words)`);
    issues.forEach(i => console.log(`   ${i}`));
  } else {
    console.log(`\x1b[32m✓ ${file}\x1b[0m (${wordCount} words)`);
  }
}

console.log(`\n\n=== Summary ===`);
console.log(`Total posts: ${files.length}`);
console.log(`Issues found: ${results.length}`);
results.forEach(r => console.log(`  - ${r.file}: ${r.issues}`));
