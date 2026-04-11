import { app, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createLogger } from '@pegasus/utils/logger';

const logger = createLogger('AutoUpdater');

const GITHUB_RELEASES_URL = 'https://github.com/zpyoung/pegasus/releases/latest';

// macOS auto-install requires a valid Developer ID signature (Squirrel.Mac).
// This app is not signed, so on macOS we fall back to a "1-click open the
// download page in the browser" flow instead of trying to quitAndInstall.
const UNSIGNED_MAC = process.platform === 'darwin';

export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    logger.info('Skipping auto-updater in development mode');
    return;
  }

  autoUpdater.logger = {
    info: (msg: unknown) => logger.info(String(msg)),
    warn: (msg: unknown) => logger.warn(String(msg)),
    error: (msg: unknown) => logger.error(String(msg)),
    debug: (msg: unknown) => logger.debug(String(msg)),
  };

  // On unsigned macOS, don't bother downloading — we can't install it anyway.
  autoUpdater.autoDownload = !UNSIGNED_MAC;
  autoUpdater.autoInstallOnAppQuit = !UNSIGNED_MAC;

  autoUpdater.on('update-available', async (info) => {
    logger.info(`Update available: ${info.version}`);
    if (UNSIGNED_MAC) {
      const result = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Open download page', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Pegasus ${info.version} is available.`,
        detail:
          'Download the new DMG and drag it over your existing Pegasus.app to update. ' +
          `You are currently on ${app.getVersion()}.`,
      });
      if (result.response === 0) {
        await shell.openExternal(GITHUB_RELEASES_URL);
      }
    }
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('No update available');
  });

  autoUpdater.on('download-progress', (progress) => {
    logger.info(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (UNSIGNED_MAC) return; // handled in update-available
    logger.info(`Update downloaded: ${info.version}`);
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Pegasus ${info.version} has been downloaded.`,
      detail: 'Restart the application to apply the update.',
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (err) => {
    logger.warn(`Auto-updater error: ${err.message}`);
  });

  autoUpdater.checkForUpdates().catch((err: Error) => {
    logger.warn(`Initial update check failed: ${err.message}`);
  });
}
