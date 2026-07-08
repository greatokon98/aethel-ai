import fs from 'node:fs';
import path from 'node:path';
import parseFrontmatter from 'front-matter';

export interface PostData {
  title: string;
  excerpt: string;
  publishDate: Date;
  featuredImage: string;
  categories: string[];
  tags: string[];
  author: string;
  featured: boolean;
  slug: string;
  readingTime: number;
  draft: boolean;
  titleFontSize: string;
  titleLineHeight: string;
}

function getSlug(file: string) {
  return file.replace(/\.md$/, '');
}

function getReadingTime(body: string) {
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}

export function loadAllPosts(): PostData[] {
  const postsDir = path.resolve('src/content/posts');
  const files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  return files
    .map((file) => {
      const content = fs.readFileSync(path.join(postsDir, file), 'utf-8');
      const { attributes, body } = parseFrontmatter(content);
      return {
        title: (attributes as any).title || '',
        excerpt: (attributes as any).excerpt || '',
        publishDate: new Date((attributes as any).publishDate || Date.now()),
        featuredImage: (attributes as any).featuredImage || '',
        categories: ((attributes as any).categories as string[]) || [],
        tags: ((attributes as any).tags as string[]) || [],
        author: ((attributes as any).author as string) || 'Aethel',
        featured: ((attributes as any).featured as boolean) || false,
        slug: getSlug(file),
        readingTime: getReadingTime(body),
        draft: ((attributes as any).draft as boolean) || false,
        titleFontSize: ((attributes as any).titleFontSize as string) || '20',
        titleLineHeight: ((attributes as any).titleLineHeight as string) || '1.3',
      };
    })
    .filter((p) => !p.draft)
    .sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return b.publishDate.getTime() - a.publishDate.getTime();
    });
}

export interface PaginatedResult {
  posts: PostData[];
  totalPages: number;
  currentPage: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function paginatePosts(posts: PostData[], page: number, perPage: number): PaginatedResult {
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const start = (currentPage - 1) * perPage;
  const sliced = posts.slice(start, start + perPage);
  return {
    posts: sliced,
    totalPages,
    currentPage,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}
