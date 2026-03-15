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

const app = express();
const PORT = 3000;

// Configure multer for file uploads
const upload = multer({ dest: '/tmp/uploads/' });

app.get('/api/build', (req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Please use POST to upload a mod.' });
});

app.post('/api/build', upload.single('sourceZip'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const jobId = uuidv4();
  const workDir = path.join('/tmp/jobs', jobId);
  const sourceZipPath = req.file.path;

  try {
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

    // 4. Run gradle build
    let buildCommand = '';
    const gradlewPath = path.join(projectDir, 'gradlew');
    
    // Check if Java is installed, if not, download it
    let javaHome = process.env.JAVA_HOME;
    let pathEnv = process.env.PATH;
    
    try {
      await execAsync('java -version');
    } catch (err) {
      console.log('Java not found globally. Checking for local JDK...');
      const jdkDir = '/tmp/jdk21';
      const javaBin = path.join(jdkDir, 'bin', 'java');
      
      if (!await fs.pathExists(javaBin)) {
        console.log('Downloading JDK 21...');
        await fs.ensureDir(jdkDir);
        
        // Determine architecture
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
        const jdkUrl = `https://api.adoptium.net/v3/binary/latest/21/ga/linux/${arch}/jdk/hotspot/normal/eclipse`;
        const tarPath = '/tmp/jdk.tar.gz';
        
        await execAsync(`curl -f -L -o ${tarPath} "${jdkUrl}"`);
        console.log('Extracting JDK...');
        await execAsync(`tar -xzf ${tarPath} -C ${jdkDir} --strip-components=1`);
        await fs.remove(tarPath);
        console.log('JDK installed locally.');
      }
      
      javaHome = jdkDir;
      pathEnv = `${path.join(jdkDir, 'bin')}:${process.env.PATH}`;
    }

    if (await fs.pathExists(gradlewPath)) {
      // Fix Windows line endings (CRLF -> LF) which cause "bad interpreter" errors on Linux
      const gradlewContent = await fs.readFile(gradlewPath, 'utf8');
      await fs.writeFile(gradlewPath, gradlewContent.replace(/\r\n/g, '\n'));
      await execAsync(`chmod +x ${gradlewPath}`);
      buildCommand = './gradlew build';
    } else {
      console.log('gradlew not found, downloading Gradle...');
      const gradleVersion = '8.8'; // A good default version for modern Minecraft mods
      const gradleDir = '/tmp/gradle';
      const gradleBin = path.join(gradleDir, `gradle-${gradleVersion}`, 'bin', 'gradle');
      
      if (!await fs.pathExists(gradleBin)) {
        await fs.ensureDir(gradleDir);
        const gradleUrl = `https://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`;
        const zipPath = '/tmp/gradle.zip';
        
        await execAsync(`curl -f -L -o ${zipPath} "${gradleUrl}"`);
        console.log('Extracting Gradle...');
        let gradleZip;
        try {
          gradleZip = new AdmZip(zipPath);
        } catch (err: any) {
          throw new Error(`Failed to read downloaded Gradle zip: ${err.message}`);
        }
        gradleZip.extractAllTo(gradleDir, true);
        await fs.remove(zipPath);
        await execAsync(`chmod +x ${gradleBin}`);
        console.log('Gradle installed locally.');
      }
      
      buildCommand = `${gradleBin} build`;
    }
    
    console.log(`Running build command: ${buildCommand} in ${projectDir}`);
    
    try {
      const { stdout, stderr } = await execAsync(buildCommand, { 
        cwd: projectDir,
        env: { ...process.env, JAVA_HOME: javaHome, PATH: pathEnv },
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });
      console.log('Build stdout:', stdout);
      if (stderr) console.error('Build stderr:', stderr);
    } catch (error: any) {
      console.error('Build failed:', error);
      throw new Error(`Build failed: ${error.message}\n\nStdout: ${error.stdout}\n\nStderr: ${error.stderr}`);
    }

    // 5. Find the resulting .jar file
    const libsDir = path.join(projectDir, 'build', 'libs');
    if (!await fs.pathExists(libsDir)) {
      throw new Error('build/libs directory not found after build.');
    }

    const jarFiles = (await fs.readdir(libsDir)).filter(file => file.endsWith('.jar'));
    if (jarFiles.length === 0) {
      throw new Error('No .jar files found in build/libs after build.');
    }

    // Usually we want the main jar, not -sources or -dev
    let mainJar = jarFiles.find(f => !f.includes('-sources') && !f.includes('-dev'));
    if (!mainJar) mainJar = jarFiles[0]; // fallback

    const mainJarPath = path.join(libsDir, mainJar);

    // 6. Create a zip containing just the .jar file
    const resultZip = new AdmZip();
    resultZip.addLocalFile(mainJarPath);
    
    const resultZipPath = path.join(workDir, 'result.zip');
    resultZip.writeZip(resultZipPath);

    // 7. Send the zip file back to the client
    res.download(resultZipPath, 'mod-build.zip', async (err) => {
      if (err) {
        console.error('Error sending file:', err);
      }
      // Clean up after sending
      await fs.remove(workDir);
      await fs.remove(sourceZipPath);
    });

  } catch (error: any) {
    console.error('Error processing build:', error);
    res.status(500).json({ error: error.message || 'An error occurred during the build process.' });
    
    // Clean up on error
    try {
      await fs.remove(workDir);
      await fs.remove(sourceZipPath);
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }
  }
});

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
