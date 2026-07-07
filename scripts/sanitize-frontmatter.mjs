import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const POSTS_DIR = 'src/content/posts';

function yamlEscape(str) {
  return str.replace(/(?<!\\)"/g, '\\"');
}

function sanitizeFrontmatter(filePath) {
  let content = readFileSync(filePath, 'utf8');
  const original = content;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  const frontmatter = fmMatch[1];
  const lines = frontmatter.split('\n');
  let changed = false;

  const sanitized = lines.map(line => {
    const match = line.match(/^(\s*[\w-]+:\s*)"(.*)"(\s*)$/);
    if (!match) return line;

    const prefix = match[1];
    let value = match[2];
    const suffix = match[3];

    const escaped = yamlEscape(value);
    if (escaped !== value) {
      changed = true;
      return `${prefix}"${escaped}"${suffix}`;
    }
    return line;
  });

  if (!changed) return false;

  content = content.replace(fmMatch[0], `---\n${sanitized.join('\n')}\n---`);
  writeFileSync(filePath, content, 'utf8');
  return true;
}

function main() {
  const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  let fixed = 0;

  for (const f of files) {
    if (sanitizeFrontmatter(join(POSTS_DIR, f))) {
      console.log(`  fixed: ${f}`);
      fixed++;
    }
  }

  if (fixed === 0) {
    console.log('All frontmatter already clean.');
  } else {
    console.log(`Fixed ${fixed} file(s).`);
  }
}

main();
