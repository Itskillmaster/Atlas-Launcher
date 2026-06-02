const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const configPath = path.join(app.getPath('appData'), 'AtlasLauncher', 'config.json');
const tokensPath = path.join(app.getPath('appData'), 'AtlasLauncher', 'tokens.json');

let tokens = {};

function loadTokens() {
  try {
    if (fs.existsSync(tokensPath)) {
      const data = fs.readFileSync(tokensPath, 'utf-8');
      tokens = JSON.parse(data);
    } else {
      tokens = {};
      saveTokens();
    }
  } catch (error) {
    console.error('❌ خطا در خواندن فایل توکن‌ها:', error.message);
    tokens = {};
    saveTokens();
  }
}

function saveTokens() {
  try {
    const dir = path.dirname(tokensPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  } catch (error) {
    console.error('❌ خطا در ذخیره توکن‌ها:', error.message);
  }
}

function generateOfflineToken(username) {
  const systemId = crypto.createHash('sha256')
    .update(`${os.hostname()}-${os.platform()}-${os.userInfo().username}`)
    .digest('hex')
    .substring(0, 16);
  
  const tokenData = `${username}-offline-${systemId}-${Date.now()}`;
  const token = crypto.createHash('sha256')
    .update(tokenData)
    .digest('hex');
  
  return `offline-${token.substring(0, 32)}`;
}

function getOfflineToken(username) {
  if (tokens[username]) {
    return tokens[username];
  }
  
  const newToken = generateOfflineToken(username);
  tokens[username] = newToken;
  saveTokens();
  return newToken;
}


function loadConfig() {

  const totalMemBytes = os.totalmem();
  const totalMemGB = Math.round(totalMemBytes / (1024 * 1024 * 1024));
  let defaultRam = Math.floor(totalMemGB / 2);
  if (defaultRam > 6) defaultRam = 6;
  if (defaultRam < 2) defaultRam = 2;


  const defaultConfig = {
    java8Path: "",
    java17Path: "",
    java21Path: "",
    gameDir: autoDetectMinecraftPath() || "",
    versionNumber: "",
    versionType: "release",
    ram: defaultRam,
    lastPlayedVersion: null,
    lastUsername: "Player"
  };

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
  
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    const parsedConfig = JSON.parse(configData);
    
    
    const mergedConfig = { ...defaultConfig, ...parsedConfig };
    
    
    fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2));
    
    return mergedConfig;
  } catch (error) {
    console.error('❌ خطا در خواندن فایل config:', error.message);
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
}

function autoDetectMinecraftPath() {
  const username = os.userInfo().username;
  const minecraftPath = `C:\\Users\\${username}\\AppData\\Roaming\\.minecraft`;
  
  if (fs.existsSync(minecraftPath)) {
    return minecraftPath;
  }
  return null;
}

function getAvailableVersions(gameDir) {
  if (!gameDir) {
    console.error('❌ gameDir is null or undefined');
    return [];
  }
  
  const versionsDir = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsDir)) {
    console.error('❌ پوشه versions یافت نشد:', versionsDir);
    return [];
  }
  
  const versions = [];
  try {
    const folders = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
      
    folders.forEach(folder => {
      const jsonPath = path.join(versionsDir, folder, `${folder}.json`);
      if (fs.existsSync(jsonPath)) {
        try {
          const versionData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          versions.push({
            number: folder,
            type: versionData.type || 'release'
          });
        } catch (err) {
          console.error(`❌ خطا در خواندن ${jsonPath}:`, err.message);
        }
      }
    });
  } catch (err) {
    console.error('❌ خطا در خواندن پوشه versions:', err.message);
    return [];
  }
  
  return versions.sort((a, b) => b.number.localeCompare(a.number));
}

function getRequiredJavaVersion(versionNumber) {
  const version = parseFloat(versionNumber);
  
  if (version >= 1.21) {
    return 21;
  } else if (version >= 1.18) {
    return 17;
  } else if (version >= 1.17) {
    return 16;
  } else {
    return 8;
  }
}

function buildJavaArgs(versionNumber, ram, nativesDir, log4jPath) {
  const args = [
    `-Xmx${ram}G`,
    `-Xms${Math.floor(ram / 2)}G`,
    '-Djava.library.path=' + nativesDir
  ];
  
  const version = parseFloat(versionNumber);
  if (version < 1.17 && fs.existsSync(log4jPath)) {
    args.push(`-Dlog4j.configurationFile=${log4jPath}`);
  }
  
  args.push('-XX:+UnlockExperimentalVMOptions');
  args.push('-XX:+UseG1GC');
  args.push('-XX:G1NewSizePercent=20');
  args.push('-XX:G1ReservePercent=20');
  args.push('-XX:MaxGCPauseMillis=50');
  args.push('-XX:G1HeapRegionSize=16M');
  
  return args;
}

function buildMinecraftArgs(json, gameDir, assetsDir, username, uuid, accessToken, mode, versionNumber) {
  const args = [];
  const version = parseFloat(versionNumber);
  const isModern = version >= 1.13;
  
  const baseArgs = [
    `--username`, username,
    `--version`, versionNumber,
    `--gameDir`, gameDir,
    `--assetsDir`, assetsDir,
    `--assetIndex`, json.assetIndex?.id || '1.8',
    `--uuid`, mode === 'premium' ? uuid : '00000000-0000-0000-0000-000000000000',
    `--accessToken`, mode === 'premium' ? accessToken : getOfflineToken(username),
    `--userType`, mode === 'premium' ? 'mojang' : 'legacy'
  ];
  
  if (isModern && json.arguments && json.arguments.game) {
    for (let arg of json.arguments.game) {
      if (typeof arg === 'string') {
        if (!arg.includes('quickPlay') && 
            !arg.includes('demo') && 
            !arg.includes('${quickPlay') &&
            !arg.includes('${resolution') &&
            !arg.includes('${clientid') &&
            !arg.includes('${auth_xuid') &&
            !arg.includes('${version_type')) {
          if (arg.startsWith('--') && !args.includes(arg)) {
            args.push(arg);
          } 
          else if (!arg.startsWith('--') && args.length > 0 && args[args.length - 1].startsWith('--')) {
            if (!args[args.length - 1].includes('quickPlay')) {
              args.push(arg);
            } else {
              args.pop(); 
            }
          }
        }
      } else if (arg.rules) {
        let shouldInclude = true;
        for (const rule of arg.rules) {
          if (rule.action === 'disallow' && rule.os && rule.os.name === 'windows') {
            shouldInclude = false;
            break;
          }
        }
        if (shouldInclude && arg.value) {
          if (Array.isArray(arg.value)) {
            for (const val of arg.value) {
              if (typeof val === 'string' && 
                  !val.includes('quickPlay') && 
                  !val.includes('demo') &&
                  !val.includes('${quickPlay')) {
                args.push(val);
              }
            }
          } else if (typeof arg.value === 'string' && 
                     !arg.value.includes('quickPlay') && 
                     !arg.value.includes('demo')) {
            args.push(arg.value);
          }
        }
      }
    }
  } 
  else if (json.minecraftArguments) {
    const template = json.minecraftArguments;
    const parts = template.split(' ');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part.includes('quickPlay') && !part.includes('demo') && !part.includes('${quickPlay')) {
        if (part.startsWith('--')) {
          args.push(part);
          if (i + 1 < parts.length && !parts[i + 1].startsWith('--')) {
            const nextPart = parts[i + 1];
            if (!nextPart.includes('quickPlay') && !nextPart.includes('demo')) {
              args.push(nextPart);
              i++; 
            }
          }
        } else {
          if (i > 0 && parts[i - 1].startsWith('--') && 
              !parts[i - 1].includes('quickPlay') && 
              !parts[i - 1].includes('demo')) {
            args.push(part);
          }
        }
      }
    }
  }
  
  if (args.length === 0) {
    args.push(...baseArgs);
  }
  
  const replacements = {
    '${auth_player_name}': username,
    '${version_name}': versionNumber,
    '${game_directory}': gameDir,
    '${assets_root}': assetsDir,
    '${assets_index_name}': json.assetIndex?.id || '1.8',
    '${auth_uuid}': mode === 'premium' ? uuid : '00000000-0000-0000-0000-000000000000',
    '${auth_access_token}': mode === 'premium' ? accessToken : getOfflineToken(username),
    '${user_properties}': '{}',
    '${user_type}': mode === 'premium' ? 'mojang' : 'legacy'
  };
  
  for (let i = 0; i < args.length; i++) {
    for (const [key, value] of Object.entries(replacements)) {
      args[i] = args[i].replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }
  }
  
  const finalArgs = [];
  let skipNext = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg && (arg.includes('quickPlay') || arg.includes('demo') || arg.includes('${quickPlay'))) {
      skipNext = true;
      continue;
    }
    
    if (skipNext) {
      skipNext = false;
      continue;
    }
    
    if (arg && arg !== '' && arg !== null && arg !== undefined) {
      finalArgs.push(arg);
    }
  }
  
  return finalArgs;
}

function buildClasspath(json, librariesPath, jarPath) {
  const cpList = [];
  
  if (json.libraries) {
    for (const lib of json.libraries) {
      let shouldInclude = true;
      if (lib.rules) {
        for (const rule of lib.rules) {
          if (rule.action === 'disallow' && rule.os && rule.os.name === 'windows') {
            shouldInclude = false;
            break;
          }
        }
      }
      
      if (!shouldInclude) continue;
      
      if (lib.downloads?.artifact?.path) {
        const libPath = path.join(librariesPath, lib.downloads.artifact.path);
        if (fs.existsSync(libPath)) {
          cpList.push(libPath);
        }
      } else if (lib.name) {
        const [group, name, version] = lib.name.split(':');
        const libPath = path.join(
          librariesPath,
          group.replace(/\./g, '/'),
          name,
          version,
          `${name}-${version}.jar`
        );
        if (fs.existsSync(libPath)) {
          cpList.push(libPath);
        }
      }
    }
  }
  
  if (fs.existsSync(jarPath)) {
    cpList.push(jarPath);
  }
  
  return cpList;
}

function launchMinecraft({ mode, username, uuid, accessToken, ram, javaPath, gameDir, versionNumber, versionType }) {
  loadTokens();
  
  const versionDir = path.join(gameDir, 'versions', versionNumber);
  const jarPath = path.join(versionDir, `${versionNumber}.jar`);
  const jsonPath = path.join(versionDir, `${versionNumber}.json`);
  const librariesPath = path.join(gameDir, 'libraries');
  const nativesDir = path.join(versionDir, 'natives');
  const assetsDir = path.join(gameDir, 'assets');
  const log4jPath = path.join(assetsDir, 'log_configs', 'client-1.7.xml');
  
  if (!fs.existsSync(jarPath)) {
    console.error('❌ JAR not found:', jarPath);
    return { success: false, error: 'فایل بازی یافت نشد' };
  }
  
  if (!fs.existsSync(jsonPath)) {
    console.error('❌ JSON not found:', jsonPath);
    return { success: false, error: 'فایل تنظیمات نسخه یافت نشد' };
  }
  
  let json;
  try {
    json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (error) {
    console.error('❌ Error parsing JSON:', error);
    return { success: false, error: 'خطا در خواندن فایل تنظیمات' };
  }
  

  const finalJavaPath = javaPath; 
  
  if (!finalJavaPath || !fs.existsSync(finalJavaPath)) {
    console.error('❌ Java not found:', finalJavaPath);
    return { success: false, error: 'مسیر جاوا تنظیم نشده یا نامعتبر است.' };
  }
  
  const finalRam = ram || loadConfig().ram || 4;
  const cpList = buildClasspath(json, librariesPath, jarPath);
  const classPath = cpList.join(';');
  
  if (cpList.length === 0) {
    console.error('❌ No classpath entries found');
    return { success: false, error: 'کتابخانه‌های بازی یافت نشد' };
  }
  
  const javaArgs = buildJavaArgs(versionNumber, finalRam, nativesDir, log4jPath);
  const mcArgs = buildMinecraftArgs(json, gameDir, assetsDir, username, uuid, accessToken, mode, versionNumber);
  
  const args = [
    ...javaArgs,
    '-cp', classPath,
    json.mainClass || 'net.minecraft.client.main.Main',
    ...mcArgs
  ];
  
  console.log('🚀 Launching Minecraft...');
  console.log('📦 Version:', versionNumber);
  console.log('👤 Username:', username);
  console.log('🔑 Mode:', mode);
  console.log('💾 RAM:', finalRam + 'GB');
  console.log('☕ Java:', finalJavaPath);
  console.log('📁 Game Dir:', gameDir);
  
  const game = spawn(finalJavaPath, args, { 
    cwd: gameDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  return { success: true, process: game };
}

function saveConfig(config) {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('✅ Config saved successfully');
    return true;
  } catch (error) {
    console.error('❌ Error saving config:', error.message);
    return false;
  }
}

module.exports = { 
  launchMinecraft, 
  getAvailableVersions, 
  loadConfig,
  saveConfig, 
  autoDetectMinecraftPath,
  getOfflineToken
};
