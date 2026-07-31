import collections from 'collections/browser';
import { Component, type ComponentProps, type ComponentType, type PropsWithChildren } from 'react';

import { getMDXComponents } from '@/components/mdx';

const officialPluginDocs = collections.docs.createClientLoader<{ slug: string }>({
  component(doc, { slug }) {
    const MDX = doc.default;
    const components = getMDXComponents();
    const Link = components.a as ComponentType<ComponentProps<'a'>>;

    return (
      <MDX
        components={getMDXComponents({
          a: ({ href, ...props }) => {
            if (!href || href.startsWith('#') || href.startsWith('/')) {
              return <Link href={href} {...props} />;
            }

            const base = new URL(`https://fraq.dev/docs/plugins/${slug}.mdx`);
            const resolved = new URL(href, base);
            if (resolved.origin !== base.origin) {
              return <Link href={href} {...props} />;
            }

            resolved.pathname = resolved.pathname.replace(/\.mdx?$/, '');
            return <Link href={`${resolved.pathname}${resolved.search}${resolved.hash}`} {...props} />;
          },
        })}
      />
    );
  },
});

export function OfficialPluginDoc({ path, slug }: { path: string; slug: string }) {
  const MDX = officialPluginDocs.getComponent(path);
  return <MDX slug={slug} />;
}

export class OfficialPluginDocErrorBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <p className="text-sm text-fd-muted-foreground">官方文档加载失败，请前往文档页面查看。</p>;
    }
    return this.props.children;
  }
}
