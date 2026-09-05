import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import { FraqLogo } from '@/components/fraq-logo';
import { version } from '../../../packages/fraq/package.json';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2.5">
          <FraqLogo className="h-[18px] w-auto shrink-0" />
          <span className="inline-block whitespace-nowrap rounded-full bg-black px-[0.4rem] py-[0.15rem] text-[0.75em] leading-none text-white dark:bg-white dark:text-black">
            <code>v{version}</code>
          </span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
