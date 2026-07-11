import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = join(__dirname, '..', 'src', 'content', 'posts');

function main() {
  const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const published = [];

  for (const file of files) {
    const filePath = join(POSTS_DIR, file);
    let content = readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    const frontmatter = fmMatch[1];
    if (!frontmatter.match(/^draft:\s*true$/m)) continue;

    const dateMatch = frontmatter.match(/^publishDate:\s*["']?(\d{4}-\d{2}-\d{2})["']?$/m);
    if (!dateMatch) continue;

    const pubDate = new Date(dateMatch[1] + 'T00:00:00Z');
    if (isNaN(pubDate.getTime())) continue;

    if (pubDate <= today) {
      content = content.replace(/^draft:\s*true$/m, 'draft: false');
      writeFileSync(filePath, content, 'utf-8');
      const titleMatch = frontmatter.match(/^title:\s*["'](.+?)["']$/m);
      published.push({ file, title: titleMatch ? titleMatch[1] : file.replace('.md', '') });
    }
  }

  if (published.length > 0) {
    console.log(`Published ${published.length} post(s):`);
    for (const p of published) {
      console.log(`  - ${p.title} (${p.file})`);
    }
  } else {
    console.log('No scheduled posts due.');
  }
}

main();
