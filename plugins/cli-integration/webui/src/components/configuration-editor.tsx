import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Annotation, Compartment, EditorState, Text, Transaction } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import type { ConfigDocument } from '@fraqjs/cli-protocol';
import { useLayoutEffect, useRef, useState } from 'react';

import { configurationLanguage } from '../configuration-language';

const externalUpdate = Annotation.define<boolean>();
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', fontSize: '13px' },
  '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '28px', overflow: 'auto' },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': {
    backgroundColor: 'var(--muted)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px', minWidth: '36px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent)', color: 'var(--foreground)' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--foreground) 15%, transparent)',
  },
  '@media (max-width: 640px)': { '&': { fontSize: '12px' }, '.cm-line': { padding: '0 12px' } },
});

export function ConfigurationEditor({
  value,
  format,
  disabled,
  onChange,
}: {
  value: string;
  format: ConfigDocument['format'];
  disabled: boolean;
  onChange: (content: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const currentFormat = useRef<ConfigDocument['format'] | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const [compartments] = useState(() => ({ language: new Compartment(), editing: new Compartment() }));

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        extensions: [
          compartments.language.of([]),
          compartments.editing.of([]),
          theme,
          lineNumbers(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(externalUpdate))
            ) {
              onChangeRef.current(update.state.sliceDoc());
            }
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
      currentFormat.current = undefined;
    };
  }, [compartments]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const changed = view.state.sliceDoc() !== value;
    const effects = [
      compartments.editing.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
        EditorView.contentAttributes.of({
          id: 'configuration',
          'aria-labelledby': 'configuration-label',
          'aria-disabled': String(disabled),
          spellcheck: 'false',
          autocapitalize: 'off',
          autocorrect: 'off',
          tabindex: disabled ? '-1' : '0',
        }),
      ]),
    ];
    if (changed || currentFormat.current !== format) {
      effects.push(compartments.language.reconfigure(configurationLanguage(format, value)));
      currentFormat.current = format;
    }
    view.dispatch({
      changes: changed ? { from: 0, to: view.state.doc.length, insert: Text.of(value.split(/\r\n?|\n/)) } : undefined,
      effects,
      annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value, format, disabled, compartments]);

  return <div ref={host} className="h-[clamp(280px,57vh,650px)] min-w-0 overflow-hidden" />;
}
