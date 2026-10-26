import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';

export const configurationKeymap = [indentWithTab, ...defaultKeymap, ...historyKeymap];
