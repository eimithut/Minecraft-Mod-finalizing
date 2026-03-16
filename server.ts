import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServer as createViteServer } from 'vite';

const execAsync = promisify(exec);

const logBuffer: string[] = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  logBuffer.push(`[LOG] ${args.join(' ')}`);
  if (logBuffer.length > 100) logBuffer.shift();
  originalLog(...args);
};

console.error = (...args) => {
  logBuffer.push(`[ERR] ${args.join(' ')}`);
  if (logBuffer.length > 100) logBuffer.shift();
  originalError(...args);
};

app.get('/api/logs', (req, res) => {
  res.json({ logs: logBuffer });
});

// Store job statuses in memory
const jobs: Record<string, { 
  status: 'pending' | 'building' | 'success' | 'error', 
  message: string, 
  progress: number,
  error?: string,
  resultPath?: string,
  workDir?: string,
  sourceZipPath?: string
}> = {};

// Configure multer for file uploads
const upload = multer({ dest: '/tmp/uploads/' });

app.post('/api/build', upload.single('sourceZip'), async (req, res) => {
  console.log(`[${new Date().toISOString()}] Received build request. File: ${req.file?.originalname} (${req.file?.size} bytes)`);
  
  if (!req.file) {
    console.error('No file uploaded in request');
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const jobId = uuidv4();
  const workDir = path.join('/tmp/jobs', jobId);
  const sourceZipPath = req.file.path;

  console.log(`[${jobId}] Initializing job. WorkDir: ${workDir}`);

  // Initialize job
  jobs[jobId] = {
    status: 'pending',
    message: 'Job initialized',
    progress: 0,
    workDir,
    sourceZipPath
  };

  // Start build process in background
  runBuildJob(jobId, workDir, sourceZipPath).catch(err => {
    console.error(`[${jobId}] Job failed in background:`, err);
  });

  console.log(`[${jobId}] Returning jobId to client`);
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
    error: job.error
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
  console.log(`[${jobId}] Starting build job execution`);
  
  try {
    job.status = 'building';
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
                content = content.replace('repositories {', `repositories {\n    maven { url "${repo.url}" }`);
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
          
          if (modified) {
            await fs.writeFile(fullPath, content, 'utf8');
          }
        }
      }
    }
    await patchProjectFiles(projectDir);

    // 4. Run gradle build
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
        
        await execAsync(`curl -f -L -o ${tarPath} "${jdkUrl}"`);
        await execAsync(`tar -xzf ${tarPath} -C ${jdkDir} --strip-components=1`);
        await fs.remove(tarPath);
      }
      
      javaHome = jdkDir;
      pathEnv = `${path.join(jdkDir, 'bin')}:${process.env.PATH}`;
    }

    if (await fs.pathExists(gradlewPath)) {
      const gradlewContent = await fs.readFile(gradlewPath, 'utf8');
      await fs.writeFile(gradlewPath, gradlewContent.replace(/\r\n/g, '\n'));
      await execAsync(`chmod +x ${gradlewPath}`);
      buildCommand = './gradlew build --no-daemon --console=plain';
    } else {
      const gradleVersion = '8.8';
      const gradleDir = '/tmp/gradle';
      const gradleBin = path.join(gradleDir, `gradle-${gradleVersion}`, 'bin', 'gradle');
      
      if (!await fs.pathExists(gradleBin)) {
        await fs.ensureDir(gradleDir);
        const gradleUrl = `https://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`;
        const zipPath = '/tmp/gradle.zip';
        
        await execAsync(`curl -f -L -o ${zipPath} "${gradleUrl}"`);
        let gradleZip = new AdmZip(zipPath);
        gradleZip.extractAllTo(gradleDir, true);
        await fs.remove(zipPath);
        await execAsync(`chmod +x ${gradleBin}`);
      }
      
      buildCommand = `${gradleBin} build --no-daemon --console=plain`;
    }
    
    job.message = 'Running Gradle build (this may take several minutes)...';
    job.progress = 50;
    
    try {
      const { stdout, stderr } = await execAsync(buildCommand, { 
        cwd: projectDir,
        env: { ...process.env, JAVA_HOME: javaHome, PATH: pathEnv },
        maxBuffer: 10 * 1024 * 1024 
      });
      console.log(`Job ${jobId} stdout:`, stdout);
    } catch (error: any) {
      throw new Error(`Build failed: ${error.message}\n\nStdout: ${error.stdout}\n\nStderr: ${error.stderr}`);
    }

    // 5. Find the resulting .jar file
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
