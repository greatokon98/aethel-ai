import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';

const POSTS_DIR = 'src/content/posts';
const IMAGES_DIR = 'public/images/posts';

const DATA_URI_RE = /^data:image\/(\w+);base64,(.+)$/;

function extractImages(filePath) {
  let content = readFileSync(filePath, 'utf8');
  const original = content;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  const frontmatter = fmMatch[1];
  const lines = frontmatter.split('\n');
  let changed = false;

  const slug = filePath.split('/').pop().replace(/\.md$/, '');

  const processed = lines.map(line => {
    const match = line.match(/^(\s*featuredImage:\s*)"(data:image\/(\w+);base64,(.+))"(\s*)$/);
    if (!match) return line;

    const prefix = match[1];
    const imgType = match[3];
    const b64 = match[4];
    const suffix = match[5];

    const ext = imgType === 'jpeg' ? 'jpg' : imgType;
    const fileName = slug + '.' + ext;
    const outPath = join(IMAGES_DIR, fileName);
    const publicPath = '/images/posts/' + fileName;

    try {
      const buffer = Buffer.from(b64, 'base64');
      mkdirSync(IMAGES_DIR, { recursive: true });
      writeFileSync(outPath, buffer);
      changed = true;
      console.log('  extracted: ' + fileName + ' (' + (buffer.length / 1024).toFixed(1) + ' KB)');
      return prefix + '"' + publicPath + '"' + suffix;
    } catch (e) {
      console.error('  ERROR extracting image from ' + filePath + ': ' + e.message);
      return line;
    }
  });

  if (!changed) return false;

  content = content.replace(fmMatch[0], '---\n' + processed.join('\n') + '\n---');
  writeFileSync(filePath, content, 'utf8');
  return true;
}

function main() {
  if (!existsSync(POSTS_DIR)) {
    console.error('Posts directory not found: ' + POSTS_DIR);
    process.exit(1);
  }

  const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  let extracted = 0;

  for (const f of files) {
    if (extractImages(join(POSTS_DIR, f))) {
      extracted++;
    }
  }

  if (extracted === 0) {
    console.log('No base64 images found to extract.');
  } else {
    console.log('Extracted ' + extracted + ' image(s).');
  }
}

main();
