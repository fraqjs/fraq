import { flattenTree } from 'fumadocs-core/page-tree';

import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const pages = flattenTree(source.getPageTree().children)
    .map((node) => source.getNodePage(node))
    .filter((page) => page != null);
  const scanned = await Promise.all(pages.map(getLLMText));

  return new Response(scanned.join('\n\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
