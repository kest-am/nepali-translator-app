"use client";

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  UploadCloud, FileAudio, Loader2, CheckCircle2, Copy, 
  AlertCircle, RefreshCw, Key, Download, XCircle 
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  
  // Progress states
  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercentage, setProgressPercentage] = useState(0);
  const [estimatedTime, setEstimatedTime] = useState('');
  
  const [translationResult, setTranslationResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) setApiKey(savedKey);
  }, []);

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const key = e.target.value;
    setApiKey(key);
    localStorage.setItem('gemini_api_key', key);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const validateAndSetFile = (selectedFile: File) => {
    setError(null);
    if (!selectedFile.type.includes('audio/')) {
      setError('Please upload a valid audio file (e.g., MP3).');
      return;
    }
    if (selectedFile.size > 100 * 1024 * 1024) {
      setError('File is too large. Maximum size is 100MB.');
      return;
    }
    setFile(selectedFile);
    setTranslationResult(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      validateAndSetFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      validateAndSetFile(e.target.files[0]);
    }
  };

  const handleTranslate = async () => {
    if (!file) return;
    if (!apiKey) {
      setError('Please enter your Gemini API Key first.');
      return;
    }

    setIsTranslating(true);
    setError(null);
    setTranslationResult(null);
    setProgressMessage('Initializing connection...');
    setProgressPercentage(0);
    setEstimatedTime('');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('apiKey', apiKey);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error('Failed to connect to the translation service.');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('Response stream is not readable.');

      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        // Save last partial line back to buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            
            if (data.type === 'progress') {
              setProgressMessage(data.message);
              setProgressPercentage(data.current || 0);
              
              // Simple estimate calculation
              const sizeInMb = file.size / (1024 * 1024);
              const estTotalTime = Math.max(30, sizeInMb * 5); // roughly 5s per MB for Pro models
              const remainingTime = Math.round(estTotalTime * (1 - (data.current || 0) / 100));
              setEstimatedTime(remainingTime > 0 ? `About ${remainingTime}s remaining` : 'Finalizing...');
            } else if (data.type === 'result') {
              setTranslationResult(data.text);
            } else if (data.type === 'error') {
              throw new Error(data.error);
            }
          } catch (e: any) {
            console.error('Stream parsing error:', e);
            if (e.message && !e.message.includes('JSON')) {
              throw e;
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setError('Translation process cancelled.');
      } else {
        setError(err.message || 'An unexpected error occurred.');
      }
    } finally {
      setIsTranslating(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleCopy = () => {
    if (translationResult) {
      navigator.clipboard.writeText(translationResult);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadTxt = () => {
    if (!translationResult) return;
    const blob = new Blob([translationResult], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${file?.name.split('.')[0] || 'transcript'}_translation.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadDocx = () => {
    if (!translationResult) return;
    const htmlContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head><title>Suna Transcript</title>
      <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; padding: 20px; }
      p { margin-bottom: 12px; }
      .meta { font-size: 11px; color: #777; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
      </style>
      </head>
      <body>
      <div class="meta">File: ${file?.name} | Date: ${new Date().toLocaleDateString()}</div>
      ${translationResult.split('\n').map(line => `<p>${line}</p>`).join('')}
      </body>
      </html>
    `;
    const blob = new Blob([htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${file?.name.split('.')[0] || 'transcript'}_translation.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadPdf = () => {
    if (!translationResult) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`
      <html>
      <head>
        <title>Suna Transcript Translation</title>
        <style>
          body { font-family: 'Georgia', serif; padding: 40px; color: #1e293b; max-width: 800px; margin: auto; }
          h1 { font-family: sans-serif; color: #4f46e5; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; font-size: 24px; }
          .meta { font-size: 0.9em; color: #64748b; margin-bottom: 30px; font-family: sans-serif; }
          .content { line-height: 1.8; white-space: pre-wrap; font-size: 1.1em; }
          @media print {
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <h1>Suna Transcript Translation</h1>
        <div class="meta">File: ${file?.name} | Generated on: ${new Date().toLocaleDateString()}</div>
        <div class="content">${translationResult}</div>
        <script>
          window.onload = function() { window.print(); window.close(); }
        </script>
      </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handleReset = () => {
    setFile(null);
    setTranslationResult(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-8">
      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-[20%] left-[20%] w-72 h-72 bg-purple-600 rounded-full mix-blend-screen filter blur-[128px] opacity-20 animate-pulse" />
        <div className="absolute bottom-[20%] right-[20%] w-72 h-72 bg-blue-600 rounded-full mix-blend-screen filter blur-[128px] opacity-20 animate-pulse" style={{ animationDelay: '2s' }} />
      </div>

      <div className="w-full max-w-5xl mx-auto space-y-12">
        <div className="text-center space-y-4">
          <motion.h1 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400"
          >
            Suna Translator
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto"
          >
            Upload your Nepali audio and get an accurate, diarized English translation.
            <br/><span className="text-sm text-green-400 mt-2 block">Powered by Gemini • Free API Key</span>
          </motion.p>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="max-w-md mx-auto pt-4"
          >
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Key className="h-5 w-5 text-slate-500" />
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={handleApiKeyChange}
                placeholder="Enter your Gemini API Key"
                className="block w-full pl-10 pr-3 py-2 border border-slate-700 rounded-xl leading-5 bg-slate-900/50 text-slate-300 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 sm:text-sm transition-colors"
              />
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Don't have a key? Get one for free at{" "}
              <a 
                href="https://aistudio.google.com/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline"
              >
                Google AI Studio
              </a>.
            </p>
          </motion.div>
        </div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="glass-panel rounded-3xl p-6 md:p-10 relative overflow-hidden"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
            
            <div className="space-y-6">
              <div 
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => !file && !isTranslating && fileInputRef.current?.click()}
                className={cn(
                  "border-2 border-dashed rounded-2xl p-8 transition-all duration-200 flex flex-col items-center justify-center min-h-[350px] group",
                  !file && !isTranslating && "cursor-pointer hover:bg-white/5",
                  isDragging ? "border-purple-500 bg-purple-500/10" : "border-slate-700/50",
                  file ? "bg-white/5" : ""
                )}
              >
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  accept="audio/*"
                  disabled={isTranslating}
                  className="hidden"
                />

                <AnimatePresence mode="wait">
                  {!file ? (
                    <motion.div 
                      key="upload-prompt"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center text-center space-y-4"
                    >
                      <div className="p-4 bg-slate-800/50 rounded-full group-hover:scale-110 transition-transform duration-300">
                        <UploadCloud className="w-8 h-8 text-purple-400" />
                      </div>
                      <div>
                        <p className="text-lg font-medium text-slate-200">Click or drag MP3 here</p>
                        <p className="text-sm text-slate-400 mt-1">Up to 15 minutes (Max 100MB)</p>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="file-selected"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex flex-col items-center text-center w-full"
                    >
                      <div className="p-4 bg-purple-500/20 rounded-full mb-4">
                        <FileAudio className="w-10 h-10 text-purple-400" />
                      </div>
                      <h3 className="text-lg font-medium text-slate-200 truncate w-full px-4" title={file.name}>
                        {file.name}
                      </h3>
                      <p className="text-sm text-slate-400 mt-1">
                        {(file.size / (1024 * 1024)).toFixed(2)} MB
                      </p>

                      {!isTranslating && !translationResult && (
                        <div className="mt-8 flex gap-3">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleReset(); }}
                            className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors text-sm font-medium"
                          >
                            Remove
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleTranslate(); }}
                            className="px-6 py-2 rounded-xl bg-gradient-to-r from-purple-500 to-blue-500 text-white font-medium hover:opacity-90 transition-opacity shadow-[0_0_20px_rgba(139,92,246,0.3)]"
                          >
                            Translate Now
                          </button>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {error && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex gap-3 text-red-400 items-start text-sm"
                >
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p className="flex-1">{error}</p>
                  <button 
                    onClick={handleTranslate} 
                    className="underline text-purple-400 font-semibold hover:text-purple-300"
                    disabled={isTranslating}
                  >
                    Retry
                  </button>
                </motion.div>
              )}
            </div>

            <div className="h-full flex flex-col">
              <div className="flex-1 bg-black/40 border border-white/5 rounded-2xl p-6 relative flex flex-col min-h-[350px]">
                <div className="flex justify-between items-center mb-4 pb-4 border-b border-white/5">
                  <h3 className="font-medium text-slate-300 flex items-center gap-2">
                    English Dialogue Script
                  </h3>
                  {translationResult && (
                    <div className="flex gap-2 items-center">
                      <button 
                        onClick={handleCopy}
                        className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                        title="Copy to clipboard"
                      >
                        {copied ? <CheckCircle2 className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5" />}
                      </button>
                      <button 
                        onClick={downloadTxt}
                        className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                        title="Download TXT"
                      >
                        <span className="text-xs font-semibold uppercase">txt</span>
                      </button>
                      <button 
                        onClick={downloadDocx}
                        className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                        title="Download Word (DOCX)"
                      >
                        <span className="text-xs font-semibold uppercase">doc</span>
                      </button>
                      <button 
                        onClick={downloadPdf}
                        className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                        title="Save PDF / Print"
                      >
                        <span className="text-xs font-semibold uppercase">pdf</span>
                      </button>
                      <button 
                        onClick={handleReset}
                        className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                        title="Translate another file"
                      >
                        <RefreshCw className="w-5 h-5" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar relative">
                  <AnimatePresence mode="wait">
                    {isTranslating ? (
                      <motion.div 
                        key="translating"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 flex flex-col items-center justify-center space-y-4"
                      >
                        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                        <div className="text-center space-y-2">
                          <p className="text-slate-300 font-medium">{progressMessage}</p>
                          {progressPercentage > 0 && (
                            <div className="w-48 bg-slate-800 h-2 rounded-full overflow-hidden mx-auto">
                              <div 
                                className="bg-gradient-to-r from-purple-500 to-blue-500 h-full transition-all duration-300"
                                style={{ width: `${progressPercentage}%` }}
                              />
                            </div>
                          )}
                          <p className="text-xs text-slate-500">
                            {estimatedTime}
                          </p>
                        </div>
                        <button
                          onClick={handleCancel}
                          className="mt-4 px-4 py-1.5 rounded-lg bg-red-950/30 border border-red-500/20 text-red-400 text-xs font-medium hover:bg-red-900/30 flex items-center gap-1.5 transition-colors"
                        >
                          <XCircle className="w-4 h-4" /> Cancel Process
                        </button>
                      </motion.div>
                    ) : translationResult ? (
                      <motion.div 
                        key="result"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-slate-200 leading-relaxed whitespace-pre-wrap font-medium"
                      >
                        {translationResult}
                      </motion.div>
                    ) : (
                      <motion.div 
                        key="empty"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm text-center px-4"
                      >
                        Your translation script will appear here.
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>

          </div>
        </motion.div>
      </div>
    </main>
  );
}
