import { Command, InvalidArgumentError } from 'commander';

import { startPreviewServer } from './server';

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface CliOptions {
  filePath: string;
  host: string;
  port: number;
  open: boolean;
}

const defaultHost = '127.0.0.1';
const defaultPort = 4649;

export async function runCli(args: string[]) {
  try {
    const options = parseCliArgs(args);
    const filePath = path.resolve(options.filePath);

    if (!existsSync(filePath)) {
      throw new Error(`Preview file does not exist: ${filePath}`);
    }

    const preview = await startPreviewServer({
      filePath,
      host: options.host,
      port: options.port,
    });

    console.log('Takumi preview running');
    console.log('');
    console.log(`File: ${filePath}`);
    console.log(`URL:  ${preview.url}`);
    console.log('Watch: enabled');

    if (options.open) {
      openBrowser(preview.url);
    }
  } catch (error) {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
}

function parseCliArgs(args: string[]): CliOptions {
  const program = new Command();

  program
    .name('takumi-preview')
    .description('Preview Takumi TSX components in the browser')
    .argument('<file>', 'TSX preview module')
    .option('-H, --host <host>', 'host to listen on', defaultHost)
    .option('-p, --port <port>', 'port to listen on', parsePort, defaultPort)
    .option('-o, --open', 'open the preview URL in the default browser')
    .showHelpAfterError()
    .allowExcessArguments(false)
    .exitOverride();

  program.parse(args, { from: 'user' });

  const [filePath] = program.args;
  const options = program.opts<{ host: string; port: number; open?: boolean }>();

  return {
    filePath,
    host: options.host,
    port: options.port,
    open: Boolean(options.open),
  };
}

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new InvalidArgumentError(`Invalid port: ${value}`);
  }
  return port;
}

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function formatCliError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = 'cause' in error && error.cause instanceof Error ? `\n${error.cause.message}` : '';
  return `${error.message}${cause}`;
}
