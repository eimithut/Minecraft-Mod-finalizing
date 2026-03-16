import React, { useState, useRef, useEffect } from 'react';
import { Upload, FileArchive, Loader2, CheckCircle, AlertCircle, Download, Globe, User, Clock, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { collection, addDoc, query, orderBy, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { db, storage } from './firebase';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SharedMod {
  id: string;
  name: string;
  description?: string;
  author: string;
  createdAt: any;
  downloadUrl: string;
  version?: string;
}

export default function App() {
  const [showIntro, setShowIntro] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'building' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [sharedSuccessfully, setSharedSuccessfully] = useState(false);
  const [galleryMods, setGalleryMods] = useState<SharedMod[]>([]);
  const [authorName, setAuthorName] = useState('');
  const [modDescription, setModDescription] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowIntro(false);
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'mods'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const mods = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as SharedMod[];
      setGalleryMods(mods);
    }, (error) => {
      console.error("Gallery fetch error:", error);
    });
    return () => unsubscribe();
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.name.endsWith('.zip')) {
        setFile(droppedFile);
        setStatus('idle');
        setErrorMessage('');
        setDownloadUrl(null);
      } else {
        setErrorMessage('Please upload a .zip file.');
        setStatus('error');
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      if (selectedFile.name.endsWith('.zip')) {
        setFile(selectedFile);
        setStatus('idle');
        setErrorMessage('');
        setDownloadUrl(null);
      } else {
        setErrorMessage('Please upload a .zip file.');
        setStatus('error');
      }
    }
  };

  const handleBuild = async () => {
    if (!file) return;

    setStatus('uploading');
    setErrorMessage('');
    setDownloadUrl(null);
    setProgress(10);
    setStatusMessage('Preparing source files...');

    const formData = new FormData();
    formData.append('sourceZip', file);

    try {
      console.log('Starting upload...');
      // 1. Start the build job
      const startResponse = await fetch('/api/build', {
        method: 'POST',
        body: formData,
      });

      console.log('Upload response received:', startResponse.status);

      if (!startResponse.ok) {
        const errorData = await startResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to start build job');
      }

      const { jobId } = await startResponse.json();
      console.log('Job started with ID:', jobId);
      setStatus('building');

      // 2. Poll for status
      const pollStatus = async () => {
        try {
          const statusResponse = await fetch(`/api/build/status/${jobId}`);
          if (!statusResponse.ok) {
            throw new Error('Failed to check build status');
          }

          const job = await statusResponse.json();
          
          if (job.status === 'error') {
            throw new Error(job.error || 'Build failed');
          }

          setProgress(job.progress);
          setStatusMessage(job.message);

          if (job.status === 'success') {
            // 3. Build finished, set success and download URL
            setDownloadUrl(`/api/build/download/${jobId}`);
            setStatus('success');
            return;
          }

          // Continue polling
          setTimeout(pollStatus, 2000);
        } catch (err: any) {
          setStatus('error');
          setErrorMessage(err.message || 'An error occurred during the build.');
          setProgress(0);
        }
      };

      pollStatus();
      
    } catch (error: any) {
      console.error('Build error:', error);
      setStatus('error');
      setErrorMessage(error.message || 'An unexpected error occurred during the build.');
      setProgress(0);
    }
  };

  const reset = () => {
    setFile(null);
    setStatus('idle');
    setErrorMessage('');
    setDownloadUrl(null);
    setSharedSuccessfully(false);
    setModDescription('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleShareToGallery = async () => {
    if (!downloadUrl || !file) return;
    if (!authorName.trim()) {
      alert("Please enter your name to share!");
      return;
    }

    setIsSharing(true);
    setProgress(0);
    setStatusMessage('Preparing upload...');
    
    try {
      // 1. Fetch the blob from the temporary URL
      const response = await fetch(downloadUrl);
      const blob = await response.blob();
      
      // 2. Upload the blob to Firebase Storage
      const fileName = `mods/${Date.now()}_${file.name}`;
      const storageRef = ref(storage, fileName);
      
      setStatusMessage('Uploading to cloud storage...');
      const uploadTask = uploadBytesResumable(storageRef, blob);

      await new Promise<void>((resolve, reject) => {
        uploadTask.on('state_changed', 
          (snapshot) => {
            const p = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            setProgress(p);
            if (p < 100) {
              setStatusMessage(`Uploading: ${Math.round(p)}%`);
            } else {
              setStatusMessage('Finalizing cloud storage...');
            }
          }, 
          (error) => reject(error), 
          () => resolve()
        );
      });
      
      // 3. Get the permanent public download URL
      setStatusMessage('Generating public link...');
      const permanentUrl = await getDownloadURL(uploadTask.snapshot.ref);

      // 4. Save metadata to Firestore with the PERMANENT URL
      setStatusMessage('Saving to gallery database...');
      await addDoc(collection(db, 'mods'), {
        name: file.name.replace('.zip', ''),
        author: authorName,
        description: modDescription,
        createdAt: serverTimestamp(),
        downloadUrl: permanentUrl, // This is now a permanent cloud link!
        version: '1.20.1'
      });
      
      setProgress(100);
      setStatusMessage('Shared successfully!');
      setSharedSuccessfully(true);
    } catch (error) {
      console.error("Error sharing mod:", error);
      alert("Failed to share mod to gallery. Make sure your Firebase Storage is configured.");
      setProgress(0);
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <AnimatePresence>
        {showIntro && (
          <motion.div
            key="intro"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-zinc-950"
          >
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="flex flex-col items-center"
            >
              <div className="p-6 bg-emerald-500/10 rounded-3xl mb-6 ring-1 ring-emerald-500/20">
                <FileArchive className="w-16 h-16 text-emerald-400 animate-pulse" />
              </div>
              <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-2">
                Minecraft Mod Builder
              </h1>
              <div className="flex items-center space-x-3 mt-8">
                <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
                <span className="text-zinc-400 font-medium tracking-widest uppercase text-sm">Initializing Environment</span>
              </div>
            </motion.div>
            
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.8 }}
              className="absolute bottom-10 text-zinc-500 text-sm font-medium tracking-wide"
            >
              Build by <span className="text-emerald-400">eimithut</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="max-w-3xl mx-auto px-6 py-24">
        
        <header className="mb-16 text-center">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="inline-flex items-center justify-center p-3 bg-emerald-500/10 rounded-2xl mb-6 ring-1 ring-emerald-500/20">
              <FileArchive className="w-8 h-8 text-emerald-400" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-zinc-50 mb-4">
              Minecraft Mod Builder
            </h1>
            <p className="text-lg text-zinc-400 max-w-xl mx-auto">
              Upload your mod's source code as a .zip file. We'll run the Gradle build and give you back the ready-to-play .jar file.
            </p>
          </motion.div>
        </header>

        <main>
          <AnimatePresence mode="wait">
            {status === 'idle' || status === 'error' ? (
              <motion.div
                key="upload"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3 }}
                className="space-y-6"
              >
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "relative overflow-hidden group cursor-pointer border-2 border-dashed rounded-3xl p-12 transition-all duration-300 ease-out flex flex-col items-center justify-center text-center",
                    isDragging 
                      ? "border-emerald-500 bg-emerald-500/5" 
                      : file 
                        ? "border-zinc-700 bg-zinc-900/50 hover:border-zinc-500 hover:bg-zinc-800/50" 
                        : "border-zinc-800 bg-zinc-900/20 hover:border-zinc-600 hover:bg-zinc-800/30"
                  )}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    accept=".zip"
                    className="hidden"
                  />
                  
                  {file ? (
                    <div className="flex flex-col items-center space-y-4">
                      <div className="p-4 bg-zinc-800 rounded-full text-emerald-400">
                        <FileArchive className="w-8 h-8" />
                      </div>
                      <div>
                        <p className="text-lg font-medium text-zinc-200">{file.name}</p>
                        <p className="text-sm text-zinc-500 mt-1">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                      </div>
                      <p className="text-xs text-zinc-500 mt-4 opacity-0 group-hover:opacity-100 transition-opacity">
                        Click or drag to replace
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center space-y-4">
                      <div className="p-4 bg-zinc-900 rounded-full text-zinc-400 group-hover:text-zinc-300 transition-colors">
                        <Upload className="w-8 h-8" />
                      </div>
                      <div>
                        <p className="text-lg font-medium text-zinc-300">
                          Drop your source .zip here
                        </p>
                        <p className="text-sm text-zinc-500 mt-2">
                          Must contain build.gradle and gradlew
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {status === 'error' && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-start space-x-3 text-red-400"
                  >
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="text-sm whitespace-pre-wrap font-mono overflow-x-auto">
                      {errorMessage}
                    </div>
                  </motion.div>
                )}

                <div className="flex justify-center pt-4">
                  <button
                    onClick={handleBuild}
                    disabled={!file}
                    className={cn(
                      "px-8 py-4 rounded-full font-medium text-lg transition-all duration-300",
                      file 
                        ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400 hover:shadow-[0_0_30px_-5px_rgba(16,185,129,0.4)] hover:-translate-y-0.5" 
                        : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    )}
                  >
                    Build Mod
                  </button>
                </div>
              </motion.div>
            ) : status === 'uploading' || status === 'building' ? (
              <motion.div
                key="building"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3 }}
                className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-12 flex flex-col items-center justify-center text-center space-y-8"
              >
                <div className="relative">
                  <div className="absolute inset-0 bg-emerald-500/20 blur-xl rounded-full animate-pulse" />
                  <Loader2 className="w-16 h-16 text-emerald-400 animate-spin relative z-10" />
                </div>
                
                <div className="space-y-4 w-full">
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-zinc-100">
                      {statusMessage || (status === 'uploading' ? 'Uploading Source...' : 'Building Mod...')}
                    </h2>
                    <p className="text-zinc-400 text-sm">
                      {status === 'uploading' 
                        ? 'Transferring your files securely.' 
                        : 'Running Gradle build. This might take a minute or two depending on dependencies.'}
                    </p>
                  </div>
                  
                  <div className="w-full max-w-md mx-auto space-y-2">
                    <div className="flex justify-between text-xs font-mono text-zinc-500">
                      <span>PROGRESS</span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    <div className="w-full bg-zinc-950 rounded-full h-3 overflow-hidden border border-zinc-800 p-0.5">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.5 }}
                        className="h-full bg-emerald-500 rounded-full shadow-[0_0_10px_rgba(16,185,129,0.3)]" 
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3 }}
                className="bg-zinc-900/50 border border-emerald-500/20 rounded-3xl p-12 flex flex-col items-center justify-center text-center space-y-8 relative overflow-hidden"
              >
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500/0 via-emerald-500 to-emerald-500/0" />
                
                <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center ring-1 ring-emerald-500/30">
                  <CheckCircle className="w-10 h-10 text-emerald-400" />
                </div>
                
                <div className="space-y-2">
                  <h2 className="text-3xl font-semibold text-zinc-100">Build Successful!</h2>
                  <p className="text-zinc-400">
                    Your mod has been compiled into a ready-to-play .jar file.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-4 pt-4">
                  {downloadUrl && (
                    <a
                      href={downloadUrl}
                      download="mod-build.zip"
                      className="flex items-center space-x-2 px-8 py-4 bg-emerald-500 text-zinc-950 rounded-full font-medium text-lg hover:bg-emerald-400 transition-colors hover:shadow-[0_0_30px_-5px_rgba(16,185,129,0.4)]"
                    >
                      <Download className="w-5 h-5" />
                      <span>Download .zip</span>
                    </a>
                  )}
                  <button
                    onClick={reset}
                    className="px-8 py-4 bg-zinc-800 text-zinc-300 rounded-full font-medium text-lg hover:bg-zinc-700 transition-colors"
                  >
                    Build Another
                  </button>
                </div>

                {!sharedSuccessfully ? (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-12 p-8 bg-zinc-950/50 border border-zinc-800 rounded-3xl w-full max-w-lg"
                  >
                    <h3 className="text-xl font-semibold text-zinc-100 mb-4 flex items-center gap-2">
                      <Globe className="w-5 h-5 text-emerald-400" />
                      Share to Global Gallery?
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5 ml-1">
                          Creator Name
                        </label>
                        <input 
                          type="text"
                          placeholder="Your name"
                          value={authorName}
                          onChange={(e) => setAuthorName(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500/50 transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5 ml-1">
                          Description (Optional)
                        </label>
                        <textarea 
                          placeholder="What does this mod do?"
                          value={modDescription}
                          onChange={(e) => setModDescription(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500/50 transition-all h-24 resize-none"
                        />
                      </div>
                      <button
                        onClick={handleShareToGallery}
                        disabled={isSharing || !authorName.trim()}
                        className="w-full py-4 bg-zinc-100 text-zinc-950 rounded-xl font-bold hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-2 overflow-hidden relative"
                      >
                        {isSharing && (
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${progress}%` }}
                            className="absolute inset-0 bg-emerald-500/20 pointer-events-none"
                          />
                        )}
                        <div className="flex items-center gap-2 relative z-10">
                          {isSharing ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <Globe className="w-5 h-5" />
                          )}
                          <span>{isSharing ? statusMessage : 'Upload to Gallery'}</span>
                        </div>
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="mt-12 p-6 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl text-emerald-400 flex items-center gap-3"
                  >
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-medium">Shared to global gallery successfully!</span>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        <section className="mt-32">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-500/10 rounded-lg">
                <Globe className="w-6 h-6 text-emerald-400" />
              </div>
              <h2 className="text-2xl font-bold text-zinc-100">Global Mod Gallery</h2>
            </div>
            <span className="text-zinc-500 text-sm font-medium">
              {galleryMods.length} Mods Shared
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {galleryMods.length > 0 ? (
              galleryMods.map((mod) => (
                <motion.div
                  key={mod.id}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  className="bg-zinc-900/40 border border-zinc-800/50 rounded-3xl p-6 hover:border-zinc-700 transition-colors group"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div className="p-3 bg-zinc-800 rounded-2xl text-emerald-400 group-hover:scale-110 transition-transform">
                      <FileArchive className="w-6 h-6" />
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500 bg-zinc-800/50 px-3 py-1 rounded-full">
                      <Clock className="w-3 h-3" />
                      {mod.createdAt?.toDate ? mod.createdAt.toDate().toLocaleDateString() : 'Just now'}
                    </div>
                  </div>
                  
                  <h3 className="text-xl font-bold text-zinc-100 mb-2">{mod.name}</h3>
                  <p className="text-zinc-400 text-sm line-clamp-2 mb-6 h-10">
                    {mod.description || 'No description provided.'}
                  </p>
                  
                  <div className="flex items-center justify-between pt-4 border-t border-zinc-800/50">
                    <div className="flex items-center gap-2 text-zinc-300">
                      <User className="w-4 h-4 text-emerald-500" />
                      <span className="text-sm font-medium">{mod.author}</span>
                    </div>
                    
                    <a 
                      href={mod.downloadUrl}
                      download={`${mod.name}.zip`}
                      className="p-2 text-zinc-400 hover:text-emerald-400 transition-colors"
                      title="Download Mod"
                    >
                      <Download className="w-5 h-5" />
                    </a>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="col-span-full py-20 text-center bg-zinc-900/20 border border-dashed border-zinc-800 rounded-3xl">
                <p className="text-zinc-500 italic">No mods shared yet. Be the first!</p>
              </div>
            )}
          </div>
        </section>
        
      </div>
    </div>
  );
}

