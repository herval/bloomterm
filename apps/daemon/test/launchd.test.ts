import { describe, expect, it } from 'vitest';
import { LAUNCHD_LABEL, launchdPlist } from '../src/launchd.ts';

describe('launchdPlist', () => {
  it('runs `bt daemon`, keeps it alive, and escapes paths', () => {
    const plist = launchdPlist({
      program: ['/opt/node/bin/node', '/repo/node_modules/tsx/dist/cli.mjs', '/repo/apps/cli/src/main.ts', 'daemon'],
      workingDirectory: '/repo',
      logFile: '/Users/h/.bloomterm/logs/bloomd.log',
      path: '/opt/node/bin:/usr/bin',
      home: '/tmp/a&b',
    });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/repo\/node_modules\/tsx\/dist\/cli.mjs<\/string>\s*<string>\/repo\/apps\/cli\/src\/main.ts<\/string>\s*<string>daemon<\/string>/);
    expect(plist).toContain('<key>BLOOMTERM_SUPERVISED</key><string>1</string>');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(plist).toContain('<key>BLOOMTERM_HOME</key><string>/tmp/a&amp;b</string>');
    expect(plist).not.toContain('a&b');
  });
});
