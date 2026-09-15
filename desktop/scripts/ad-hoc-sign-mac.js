const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async function adHocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const productName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  const result = spawnSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' }
  );

  if (result.status !== 0) {
    throw new Error(`Ad-hoc signing failed for ${appPath} (exit ${result.status ?? 'unknown'})`);
  }
};
