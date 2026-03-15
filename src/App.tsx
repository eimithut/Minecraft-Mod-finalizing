import React, { useState, useRef } from 'react';
import { Upload, FileArchive, Loader2, CheckCircle, AlertCircle, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'building' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    const formData = new FormData();
    formData.append('sourceZip', file);

    try {
      setStatus('building');
      
      const response = await fetch('/api/build', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        let errorText = 'Build failed';
        try {
          const errorData = await response.json();
          errorText = errorData.error || errorText;
        } catch (e) {
          errorText = await response.text() || errorText;
        }
        throw new Error(errorText);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        const html = await response.text();
        console.error('Received HTML instead of zip:', html.substring(0, 500));
        throw new Error('Server returned an HTML page instead of a zip file. This might be due to a session timeout, a proxy error, or the build taking too long. Please refresh the page and try again.');
      }

      // The response is a blob (the zip file)
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      setDownloadUrl(url);
      setStatus('success');
      
    } catch (error: any) {
      console.error('Build error:', error);
      setStatus('error');
      setErrorMessage(error.message || 'An unexpected error occurred during the build.');
    }
  };

  const reset = () => {
    setFile(null);
    setStatus('idle');
    setErrorMessage('');
    setDownloadUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
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
                
                <div className="space-y-2">
                  <h2 className="text-2xl font-semibold text-zinc-100">
                    {status === 'uploading' ? 'Uploading Source...' : 'Building Mod...'}
                  </h2>
                  <p className="text-zinc-400">
                    {status === 'uploading' 
                      ? 'Transferring your files securely.' 
                      : 'Running Gradle build. This might take a minute or two depending on dependencies.'}
                  </p>
                </div>
                
                {status === 'building' && (
                  <div className="w-full max-w-md bg-zinc-950 rounded-full h-2 overflow-hidden border border-zinc-800">
                    <div className="h-full bg-emerald-500 w-full origin-left animate-[pulse_2s_ease-in-out_infinite]" />
                  </div>
                )}
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
              </motion.div>
            )}
          </AnimatePresence>
        </main>
        
      </div>
    </div>
  );
}

