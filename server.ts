import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs-extra';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createServer as createViteServer } from 'vite';

const execAsync = promisify(exec);

const app = express();
const PORT = 3000;

// Store job statuses in memory
const jobs: Record<string, { 
  status: 'pending' | 'building' | 'success' | 'error', 
  message: string, 
  progress: number,
  error?: string,
  resultPath?: string,
  workDir?: string,
  sourceZipPath?: string,
  logs: string[]
}> = {};

// Configure multer for file uploads
const upload = multer({ dest: '/tmp/uploads/' });

app.post('/api/build', upload.single('sourceZip'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const jobId = uuidv4();
  const workDir = path.join('/tmp/jobs', jobId);
  const sourceZipPath = req.file.path;

  // Initialize job
  jobs[jobId] = {
    status: 'pending',
    message: 'Job initialized',
    progress: 0,
    workDir,
    sourceZipPath,
    logs: ['[System] Job initialized']
  };

  // Start build process in background
  runBuildJob(jobId, workDir, sourceZipPath).catch(err => {
    console.error(`Job ${jobId} failed:`, err);
  });

  // Return jobId immediately
  res.json({ jobId });
});

app.get('/api/build/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    status: job.status,
    message: job.message,
    progress: job.progress,
    error: job.error,
    logs: job.logs
  });
});

app.get('/api/build/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || job.status !== 'success' || !job.resultPath) {
    return res.status(404).json({ error: 'Result not found or build not finished' });
  }

  res.download(job.resultPath, 'mod-build.zip');
  
  // Schedule cleanup for 10 minutes from now if not already scheduled
  setTimeout(async () => {
    try {
      const currentJob = jobs[jobId];
      if (currentJob) {
        if (currentJob.workDir) await fs.remove(currentJob.workDir);
        if (currentJob.sourceZipPath) await fs.remove(currentJob.sourceZipPath);
        delete jobs[jobId];
        console.log(`Cleaned up job ${jobId}`);
      }
    } catch (err) {
      console.error(`Cleanup error for job ${jobId}:`, err);
    }
  }, 10 * 60 * 1000);
});

async function runBuildJob(jobId: string, workDir: string, sourceZipPath: string) {
  const job = jobs[jobId];
  
  const log = (msg: string) => {
    console.log(`[Job ${jobId}] ${msg}`);
    job.logs.push(msg);
    if (job.logs.length > 500) job.logs.shift();
  };
  
  try {
    job.status = 'building';
    log('Extracting source files...');
    job.message = 'Extracting source files...';
    job.progress = 10;

    // 1. Create working directory
    await fs.ensureDir(workDir);

    // 2. Extract the uploaded zip
    let zip;
    try {
      zip = new AdmZip(sourceZipPath);
    } catch (err: any) {
      throw new Error(`Invalid or unsupported zip format. Please ensure you uploaded a valid .zip file. Details: ${err.message}`);
    }
    zip.extractAllTo(workDir, true);

    // 3. Find the directory containing build.gradle
    log('Locating project files...');
    job.message = 'Locating project files...';
    job.progress = 20;
    
    let projectDir = workDir;
    
    async function findBuildGradle(startDir: string): Promise<string | null> {
      const queue = [startDir];
      while (queue.length > 0) {
        const currentDir = queue.shift()!;
        const files = await fs.readdir(currentDir);
        if (files.includes('build.gradle') || files.includes('build.gradle.kts')) {
          return currentDir;
        }
        for (const file of files) {
          const fullPath = path.join(currentDir, file);
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            queue.push(fullPath);
          }
        }
      }
      return null;
    }

    const foundDir = await findBuildGradle(workDir);
    if (!foundDir) {
      throw new Error('build.gradle or build.gradle.kts not found in the uploaded zip.');
    }
    projectDir = foundDir;

    // 3.5 Auto-patch common mapping and dependency issues
    log('Applying auto-patches for 1.21 compatibility...');
    job.message = 'Applying auto-patches...';
    job.progress = 30;
    
    async function patchProjectFiles(dir: string) {
      const files = await fs.readdir(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          await patchProjectFiles(fullPath);
        } else if (fullPath.endsWith('.java')) {
          let content = await fs.readFile(fullPath, 'utf8');
          let modified = false;
          
          if (content.includes('getColorArgb')) {
            content = content.replace(/getColorArgb/g, 'getColor');
            modified = true;
          }
          if (content.includes('setColorArgb')) {
            content = content.replace(/setColorArgb/g, 'setColor');
            modified = true;
          }

          // Patch Fabric Loot API changes (1.20 -> 1.21)
          // 1. context.clearPools() is often used but might not exist or be needed in 1.21
          if (content.includes('context.clearPools()')) {
            content = content.replace(/context\.clearPools\(\);/g, '// context.clearPools(); // Patched for 1.21 compatibility');
            modified = true;
          }

          // 2. context.addPool(pool) where pool is a LootPool -> context.addPool(pool.builder()) or similar
          // Actually, in 1.21, addPool takes a LootPool.Builder.
          // If the user is doing something like:
          // LootPool pool = LootPool.builder()...build();
          // context.addPool(pool);
          // We should change it to not call .build() or use the builder directly.
          
          // Common pattern: LootPool pool = LootPool.builder()...build(); context.addPool(pool);
          const lootPoolPattern = /LootPool\s+(\w+)\s*=\s*LootPool\.builder\(\)([\s\S]*?)\.build\(\);/g;
          if (lootPoolPattern.test(content)) {
            content = content.replace(lootPoolPattern, 'LootPool.Builder $1 = LootPool.builder()$2;');
            modified = true;
          }
          
          if (modified) {
            await fs.writeFile(fullPath, content, 'utf8');
          }
        } else if (file === 'build.gradle' || file === 'build.gradle.kts') {
          let content = await fs.readFile(fullPath, 'utf8');
          let modified = false;

          // Add common repositories if missing
          const repos = [
            { id: 'shedaniel', url: 'https://maven.shedaniel.me/' },
            { id: 'terraformers', url: 'https://maven.terraformersmc.com/releases/' },
            { id: 'jitpack', url: 'https://jitpack.io' }
          ];

          for (const repo of repos) {
            if (!content.includes(repo.url) && !content.includes(repo.url.replace('https://', 'http://'))) {
              // Try to insert after repositories {
              if (content.includes('repositories {')) {
                const repoLine = content.includes('.kts') ? `    maven("${repo.url}")` : `    maven { url "${repo.url}" }`;
                content = content.replace('repositories {', `repositories {\n${repoLine}`);
                modified = true;
              }
            }
          }

          // Fix common versioning typos for cloth-config (15.0.0 -> 15.0.127 for 1.21)
          if (content.includes('cloth-config-fabric:15.0.0')) {
            content = content.replace('cloth-config-fabric:15.0.0', 'cloth-config-fabric:15.0.127');
            modified = true;
          }

          if (modified) {
            await fs.writeFile(fullPath, content, 'utf8');
          }
        } else if (file === 'gradle.properties') {
          let content = await fs.readFile(fullPath, 'utf8');
          let modified = false;
          
          if (content.includes('cloth_config_version=15.0.0')) {
            content = content.replace('cloth_config_version=15.0.0', 'cloth_config_version=15.0.127');
            modified = true;
          }

          // Force memory limits in gradle.properties to be safe
          if (!content.includes('org.gradle.jvmargs')) {
            content += '\norg.gradle.jvmargs=-Xmx320m -XX:MaxMetaspaceSize=128m -XX:+UseSerialGC\n';
            modified = true;
          } else {
            // Replace existing jvmargs if they are too high
            content = content.replace(/org\.gradle\.jvmargs\s*=\s*.*/g, 'org.gradle.jvmargs=-Xmx320m -XX:MaxMetaspaceSize=128m -XX:+UseSerialGC');
            modified = true;
          }

          // Disable daemon and parallel in properties too
          if (!content.includes('org.gradle.daemon')) {
            content += '\norg.gradle.daemon=false\n';
            modified = true;
          }
          if (!content.includes('org.gradle.parallel')) {
            content += '\norg.gradle.parallel=false\n';
            modified = true;
          }
          
          if (modified) {
            await fs.writeFile(fullPath, content, 'utf8');
          }
        } else if (file === 'settings.gradle' || file === 'settings.gradle.kts') {
          let content = await fs.readFile(fullPath, 'utf8');
          let modified = false;

          // Ensure repositories are also in settings.gradle for newer Gradle versions (pluginManagement)
          if (content.includes('pluginManagement {') && !content.includes('mavenCentral()')) {
            content = content.replace('pluginManagement {', 'pluginManagement {\n    repositories {\n        mavenCentral()\n        gradlePluginPortal()\n        maven { url "https://maven.fabricmc.net/" }\n    }');
            modified = true;
          }

          if (modified) {
            await fs.writeFile(fullPath, content, 'utf8');
          }
        }
      }
    }
    await patchProjectFiles(projectDir);

    // 4. Run gradle build
    log('Setting up build environment (JDK & Gradle)...');
    job.message = 'Setting up build environment...';
    job.progress = 40;
    
    let buildCommand = '';
    const gradlewPath = path.join(projectDir, 'gradlew');
    
    let javaHome = process.env.JAVA_HOME;
    let pathEnv = process.env.PATH;
    
    try {
      await execAsync('java -version');
    } catch (err) {
      const jdkDir = '/tmp/jdk21';
      const javaBin = path.join(jdkDir, 'bin', 'java');
      
      if (!await fs.pathExists(javaBin)) {
        await fs.ensureDir(jdkDir);
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
        const jdkUrl = `https://api.adoptium.net/v3/binary/latest/21/ga/linux/${arch}/jdk/hotspot/normal/eclipse`;
        const tarPath = '/tmp/jdk.tar.gz';
        
        // Add retries for flaky Adoptium API
        await execAsync(`curl -f -L --retry 5 --retry-delay 5 --retry-all-errors -o ${tarPath} "${jdkUrl}"`);
        await execAsync(`tar -xzf ${tarPath} -C ${jdkDir} --strip-components=1`);
        await fs.remove(tarPath);
      }
      
      javaHome = jdkDir;
      pathEnv = `${path.join(jdkDir, 'bin')}:${process.env.PATH}`;
    }

    if (await fs.pathExists(gradlewPath)) {
      log('Found gradlew, preparing execution...');
      const gradlewContent = await fs.readFile(gradlewPath, 'utf8');
      await fs.writeFile(gradlewPath, gradlewContent.replace(/\r\n/g, '\n'));
      await execAsync(`chmod +x ${gradlewPath}`);
      buildCommand = './gradlew build -x test --no-daemon --console=plain';
    } else {
      log('Gradlew not found, setting up standalone Gradle 8.8...');
      const gradleVersion = '8.8';
      const gradleDir = '/tmp/gradle';
      const gradleBin = path.join(gradleDir, `gradle-${gradleVersion}`, 'bin', 'gradle');
      
      if (!await fs.pathExists(gradleBin)) {
        log(`Downloading Gradle ${gradleVersion}...`);
        await fs.ensureDir(gradleDir);
        const gradleUrl = `https://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`;
        const zipPath = '/tmp/gradle.zip';
        
        // Add retries for Gradle download
        await execAsync(`curl -f -L --retry 5 --retry-delay 5 --retry-all-errors -o ${zipPath} "${gradleUrl}"`);
        log('Extracting Gradle...');
        let gradleZip = new AdmZip(zipPath);
        gradleZip.extractAllTo(gradleDir, true);
        await fs.remove(zipPath);
        await execAsync(`chmod +x ${gradleBin}`);
      }
      
      buildCommand = `${gradleBin} build -x test --no-daemon --console=plain`;
    }
    
    // Cleanup any existing Gradle lock files to prevent serialization/socket errors
    try {
      const gradleHome = '/tmp/.gradle';
      if (await fs.pathExists(gradleHome)) {
        log('Cleaning up Gradle lock files...');
        const lockFiles = await execAsync(`find ${gradleHome} -name "*.lock" -delete`).catch(() => {});
      }
    } catch (e) {}

    job.message = 'Running Gradle build...';
    job.progress = 50;
    log(`Starting build with command: ${buildCommand}`);
    
    const buildProcess = spawn('/bin/sh', ['-c', buildCommand], { 
      cwd: projectDir,
      env: { 
        ...process.env, 
        JAVA_HOME: javaHome, 
        PATH: pathEnv,
        // Use a persistent Gradle home in /tmp to cache dependencies across builds
        GRADLE_USER_HOME: '/tmp/.gradle',
        // Aggressively limit memory for 512MB RAM environments
        // -Xmx320m leaves room for the Node.js process and OS
        GRADLE_OPTS: '-Dorg.gradle.daemon=false -Dorg.gradle.parallel=false -Dorg.gradle.vfs.watch=false -Dorg.gradle.caching=true -Dorg.gradle.workers.max=1 -Dorg.gradle.internal.launcher.welcomeMessageEnabled=false -Dorg.gradle.jvmargs="-Xmx320m -XX:MaxMetaspaceSize=128m -XX:+UseSerialGC"',
        JAVA_OPTS: '-Xmx320m'
      }
    });

    buildProcess.stdout.on('data', (data: any) => {
      data.toString().split('\n').forEach((line: string) => {
        if (line.trim()) log(line.trim());
      });
    });

    buildProcess.stderr.on('data', (data: any) => {
      data.toString().split('\n').forEach((line: string) => {
        if (line.trim()) log(`[Error] ${line.trim()}`);
      });
    });

    await new Promise((resolve, reject) => {
      buildProcess.on('close', (code: number) => {
        if (code === 0) resolve(null);
        else reject(new Error(`Gradle build failed with exit code ${code}`));
      });
    });

    // 5. Find the resulting .jar file
    log('Build successful! Packaging build artifacts...');
    job.message = 'Packaging build artifacts...';
    job.progress = 90;
    
    const libsDir = path.join(projectDir, 'build', 'libs');
    if (!await fs.pathExists(libsDir)) {
      throw new Error('build/libs directory not found after build.');
    }

    const jarFiles = (await fs.readdir(libsDir)).filter(file => file.endsWith('.jar'));
    if (jarFiles.length === 0) {
      throw new Error('No .jar files found in build/libs after build.');
    }

    let mainJar = jarFiles.find(f => !f.includes('-sources') && !f.includes('-dev'));
    if (!mainJar) mainJar = jarFiles[0];

    const mainJarPath = path.join(libsDir, mainJar);

    // 6. Create a zip containing just the .jar file
    const resultZip = new AdmZip();
    resultZip.addLocalFile(mainJarPath);
    
    const resultZipPath = path.join(workDir, 'result.zip');
    resultZip.writeZip(resultZipPath);

    job.status = 'success';
    job.message = 'Build complete!';
    job.progress = 100;
    job.resultPath = resultZipPath;

  } catch (error: any) {
    job.status = 'error';
    job.error = error.message || 'An error occurred during the build process.';
    
    // Clean up on error
    try {
      if (workDir) await fs.remove(workDir);
      if (sourceZipPath) await fs.remove(sourceZipPath);
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }
  }
}

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
