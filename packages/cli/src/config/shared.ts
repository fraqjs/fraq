import * as YAML from 'yaml';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function parseConfigFile(filePath: string): unknown {
  const configContent = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(configContent);
  }
  return YAML.parse(configContent);
}

export function findConfigPath(): string {
  const configCandidates = ['fraq.yml', 'fraq.yaml', 'fraq.json'];
  for (const candidate of configCandidates) {
    const configPath = path.resolve(process.cwd(), candidate);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  throw new Error('No configuration file found. Please create a fraq.yml, fraq.yaml, or fraq.json file.');
}

export function readVersions(): Record<string, string> {
  const versionsPath = path.resolve(process.cwd(), 'versions.yml');
  if (!existsSync(versionsPath)) {
    return {};
  }

  const parsedVersions = parseConfigFile(versionsPath);
  const versions: Record<string, string> = {};
  for (const [name, version] of Object.entries(parsedVersions ?? {})) {
    if (typeof version !== 'string') {
      throw new Error(`Invalid version for ${name} in versions.yml: expected a string.`);
    }
    versions[name] = version;
  }
  return versions;
}
