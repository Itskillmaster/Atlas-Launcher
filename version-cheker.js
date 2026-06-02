const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const os = require('os');

const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
const TLAUNCHER_MANIFEST = 'https://tlauncher.org/versions';

class VersionChecker {
  constructor(gameDir, versionNumber, onProgress) {
    this.gameDir = gameDir;
    this.versionNumber = versionNumber;
    this.versionDir = path.join(gameDir, 'versions', versionNumber);
    this.librariesDir = path.join(gameDir, 'libraries');
    this.nativesDir = path.join(this.versionDir, 'natives');
    this.jsonPath = path.join(this.versionDir, `${versionNumber}.json`);
    this.jarPath = path.join(this.versionDir, `${versionNumber}.jar`);
    this.onProgress = onProgress || (() => {});
    this.totalTasks = 0;
    this.completedTasks = 0;
    this.cancelled = false;
  }

  reportProgress(message, increment = 0) {
    const percent = this.totalTasks === 0 ? 0 : Math.min(100, Math.floor((this.completedTasks / this.totalTasks) * 100));
    this.onProgress({ percent, message });
    if (increment > 0) this.completedTasks += increment;
  }

  cancel() {
    this.cancelled = true;
  }

  async ensureDir(dir) {
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  async downloadFile(url, dest) {
    const writer = fsSync.createWriteStream(dest);
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 30000
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async fetchVersionJson() {
    this.reportProgress('در حال بررسی فایل نسخه...');
    await this.ensureDir(this.versionDir);
    if (fsSync.existsSync(this.jsonPath)) {
      try {
        const data = await fs.readFile(this.jsonPath, 'utf-8');
        return JSON.parse(data);
      } catch (e) { /* خراب، دوباره دانلود می‌کنیم */ }
    }
    try {
      return await this.downloadFromMojang();
    } catch (err) {
      this.reportProgress('خطا در اتصال به سرورهای رسمی. تلاش با TLauncher...');
      return await this.downloadFromTLauncher();
    }
  }

  async downloadFromMojang() {
    const manifest = (await axios.get(MOJANG_MANIFEST)).data;
    const versionInfo = manifest.versions.find(v => v.id === this.versionNumber);
    if (!versionInfo) throw new Error('نسخه در منیفست Mojang یافت نشد.');
    const versionData = (await axios.get(versionInfo.url)).data;
    await fs.writeFile(this.jsonPath, JSON.stringify(versionData, null, 2));
    return versionData;
  }

  async downloadFromTLauncher() {
    const manifest = (await axios.get(TLAUNCHER_MANIFEST)).data;
    const versionInfo = manifest.versions.find(v => v.id === this.versionNumber);
    if (!versionInfo) throw new Error('نسخه در TLauncher یافت نشد.');
    const versionData = (await axios.get(versionInfo.url)).data;
    await fs.writeFile(this.jsonPath, JSON.stringify(versionData, null, 2));
    return versionData;
  }

  async checkClientJar(json) {
    this.reportProgress('بررسی فایل اجرایی بازی...');
    if (fsSync.existsSync(this.jarPath)) return true;
    const url = json.downloads?.client?.url;
    if (!url) throw new Error('آدرس دانلود jar اصلی یافت نشد.');
    this.reportProgress('دانلود فایل اجرایی...');
    await this.downloadFile(url, this.jarPath);
  }

  async checkLibraries(json) {
    const libraries = json.libraries || [];
    this.totalTasks += libraries.length;
    this.reportProgress(`در حال بررسی کتابخانه‌ها (${libraries.length} عدد)...`);

    for (const lib of libraries) {
      if (this.cancelled) throw new Error('عملیات توسط کاربر لغو شد.');
      try {
        await this.processLibrary(lib);
      } catch (err) {
        
        console.error(`خطا در کتابخانه ${lib.name}:`, err.message);
      }
      this.completedTasks++;
      this.reportProgress('کتابخانه‌ها...', 0);
    }

    await this.extractNatives(json);
  }

  async processLibrary(lib) {
    const artifact = lib.downloads?.artifact;
    if (!artifact) return;
    const libPath = path.join(this.librariesDir, artifact.path);
    if (fsSync.existsSync(libPath)) return;
    await this.ensureDir(path.dirname(libPath));
    await this.downloadFile(artifact.url, libPath);
  }

  async extractNatives(json) {
    this.reportProgress('استخراج کتابخانه‌های بومی...');
    await this.ensureDir(this.nativesDir);

    const currentOs = os.platform(); 
    const arch = os.arch();
    const osNameMap = { win32: 'windows', darwin: 'osx', linux: 'linux' };
    const osName = osNameMap[currentOs] || currentOs;

    const natives = [];
    for (const lib of json.libraries) {
      if (!lib.natives) continue;
      if (lib.natives[osName]) {
        const classifier = lib.natives[osName].replace('${arch}', arch.includes('64') ? '64' : '32');
        if (lib.downloads?.classifiers?.[classifier]) {
          natives.push(lib.downloads.classifiers[classifier]);
        }
      }
    }

    this.totalTasks += natives.length;
    for (const native of natives) {
      if (this.cancelled) throw new Error('عملیات توسط کاربر لغو شد.');
      try {
        const nativePath = path.join(this.librariesDir, native.path);
        if (!fsSync.existsSync(nativePath)) {
          await this.ensureDir(path.dirname(nativePath));
          await this.downloadFile(native.url, nativePath);
        }
        const zip = new AdmZip(nativePath);
        zip.extractAllTo(this.nativesDir, true);
      } catch (err) {
        console.error(`خطا در استخراج ${native.path}:`, err.message);
      }
      this.completedTasks++;
      this.reportProgress('استخراج بومی‌ها...', 0);
    }
  }

  async run() {
    try {
      await this.ensureDir(this.versionDir);
      const json = await this.fetchVersionJson();
      await this.checkClientJar(json);
      await this.checkLibraries(json);
      this.reportProgress('آماده‌سازی با موفقیت انجام شد.', 100);
      return { success: true };
    } catch (error) {
      this.reportProgress(`خطا: ${error.message}`, 100);
      throw error;
    }
  }
}

module.exports = { VersionChecker };
