import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChromeProfileInfo } from './types.js';

export class ProfileManager {
  public static getChromeUserDataPath(): string | null {
    const platform = process.platform;
    let baseDir = '';

    if (platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      baseDir = path.join(localAppData, 'Google', 'Chrome', 'User Data');
    } else if (platform === 'darwin') {
      baseDir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    } else if (platform === 'linux') {
      baseDir = path.join(os.homedir(), '.config', 'google-chrome');
    }

    return fs.existsSync(baseDir) ? baseDir : null;
  }

  public static listProfiles(customUserDataDir?: string): ChromeProfileInfo[] {
    const userDataPath = customUserDataDir || this.getChromeUserDataPath();
    if (!userDataPath || !fs.existsSync(userDataPath)) {
      return [];
    }

    const profiles: ChromeProfileInfo[] = [];
    const localStatePath = path.join(userDataPath, 'Local State');

    let infoCache: Record<string, any> = {};

    if (fs.existsSync(localStatePath)) {
      try {
        const localStateContent = fs.readFileSync(localStatePath, 'utf-8');
        const parsed = JSON.parse(localStateContent);
        infoCache = parsed?.profile?.info_cache || {};
      } catch (err) {
        // failed to parse Local State, fallback to folder scanning
      }
    }

    // List profile directories
    const entries = fs.readdirSync(userDataPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      if (folderName === 'Default' || folderName.startsWith('Profile ')) {
        const fullPath = path.join(userDataPath, folderName);
        const cacheEntry = infoCache[folderName] || {};

        const displayName = cacheEntry.name || cacheEntry.gaia_name || folderName;
        const email = cacheEntry.user_name || undefined;
        const avatarUrl = cacheEntry.last_downloaded_gaia_picture_url_with_size || undefined;

        profiles.push({
          id: folderName,
          name: displayName,
          email,
          path: fullPath,
          avatarUrl,
        });
      }
    }

    return profiles;
  }

  public static findProfile(
    identifier: string,
    customUserDataDir?: string
  ): ChromeProfileInfo | null {
    const profiles = this.listProfiles(customUserDataDir);
    if (profiles.length === 0) return null;

    const query = identifier.trim().toLowerCase();

    // 1. Match exact ID
    const byId = profiles.find((p) => p.id.toLowerCase() === query);
    if (byId) return byId;

    // 2. Match exact name
    const byName = profiles.find((p) => p.name.toLowerCase() === query);
    if (byName) return byName;

    // 3. Match email
    const byEmail = profiles.find((p) => p.email && p.email.toLowerCase() === query);
    if (byEmail) return byEmail;

    // 4. Partial match
    const byPartial = profiles.find(
      (p) =>
        p.id.toLowerCase().includes(query) ||
        p.name.toLowerCase().includes(query) ||
        (p.email && p.email.toLowerCase().includes(query))
    );
    if (byPartial) return byPartial;

    return null;
  }

  public static getProfileIsolatedDir(profileId: string): string {
    const targetDir = path.join(os.homedir(), '.mcp-chatgpt', 'profiles', profileId);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return targetDir;
  }
}
