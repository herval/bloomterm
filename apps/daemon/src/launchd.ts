// A LaunchAgent that keeps bloomd running while you're logged in (SPEC §8.1).
// It runs in your GUI session, so the parked Chrome windows can still come forward.

export const LAUNCHD_LABEL = 'dev.bloomterm.bloomd';

export interface PlistInput {
  /** The command and its arguments: `bt daemon`, from the checkout or the app. */
  program: string[];
  workingDirectory: string;
  logFile: string;
  path: string;
  home?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist(i: PlistInput): string {
  // Supervised: launchd starts it again when it exits with an error, so bloomd can restart itself.
  const env: Record<string, string> = { PATH: i.path, BLOOMTERM_SUPERVISED: '1' };
  if (i.home) env.BLOOMTERM_HOME = i.home;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${i.program.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(i.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(i.logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(i.logFile)}</string>
</dict>
</plist>
`;
}
