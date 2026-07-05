import { GoogleGenAI } from '@google/genai';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export const maxDuration = 300; // Allow long execution on platforms that support it

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const sendProgress = (message: string, current?: number, total?: number) => {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: 'progress', message, current, total }) + '\n'
          )
        );
      };

      const sendError = (error: string) => {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: 'error', error }) + '\n'
          )
        );
      };

      const sendResult = (text: string) => {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: 'result', text }) + '\n'
          )
        );
      };

      let tempFilePath = '';
      let chunkFiles: string[] = [];
      let ai: GoogleGenAI | null = null;
      let uploadedFileNames: string[] = [];

      try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const apiKey = formData.get('apiKey') as string;

        if (!file) {
          sendError('No file provided.');
          controller.close();
          return;
        }
        if (!apiKey) {
          sendError('Gemini API key is required.');
          controller.close();
          return;
        }

        ai = new GoogleGenAI({ apiKey });

        const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

        sendProgress(`Validating Gemini model '${modelName}'...`, 2, 100);
        try {
          const modelInfo = await ai.models.get({ model: modelName });
          const supportsGenerate = modelInfo.supportedActions?.some(m => m.toLowerCase().includes('generatecontent') || m.toLowerCase().includes('predict'));
          if (!supportsGenerate) {
            throw new Error(`Model '${modelName}' does not support generating content.`);
          }
        } catch (getErr: any) {
          console.warn(`Model validation warning: ${getErr.message || getErr}. Proceeding anyway.`);
        }

        sendProgress('Saving audio file to temporary storage...', 4, 100);

        const tempDir = os.tmpdir();
        tempFilePath = path.join(tempDir, `upload-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`);
        const buffer = Buffer.from(await file.arrayBuffer());
        await fs.promises.writeFile(tempFilePath, buffer);

        sendProgress('Detecting audio codec and container...', 8, 100);

        let codec = 'mp3';
        let extension = 'mp3';
        let mimeType = 'audio/mp3';

        const ffprobePath = '/opt/homebrew/bin/ffprobe';
        let probeCmd = `"${ffprobePath}" -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${tempFilePath}"`;
        let probeOutput = '';

        try {
          const { stdout } = await execPromise(probeCmd);
          probeOutput = stdout.trim();
        } catch (probeErr) {
          try {
            const { stdout } = await execPromise(`ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${tempFilePath}"`);
            probeOutput = stdout.trim();
          } catch (innerProbeErr) {
            console.error('FFprobe detection failed, defaulting to mp3', innerProbeErr);
          }
        }

        if (probeOutput) {
          codec = probeOutput.toLowerCase();
          if (codec === 'aac') {
            extension = 'm4a';
            mimeType = 'audio/m4a';
          } else if (codec === 'mp3') {
            extension = 'mp3';
            mimeType = 'audio/mp3';
          } else if (codec === 'flac') {
            extension = 'flac';
            mimeType = 'audio/flac';
          } else if (codec === 'vorbis' || codec === 'opus') {
            extension = 'ogg';
            mimeType = 'audio/ogg';
          } else if (codec.startsWith('pcm')) {
            extension = 'wav';
            mimeType = 'audio/wav';
          } else {
            // Default fallback for unknown codecs
            extension = 'm4a';
            mimeType = 'audio/m4a';
          }
        }

        sendProgress(`Segmenting audio (${codec.toUpperCase()}) into 5-minute chunks...`, 12, 100);

        const chunkPrefix = `chunk-${Date.now()}`;
        const outputPattern = path.join(tempDir, `${chunkPrefix}-%03d.${extension}`);
        
        // Use ffmpeg to segment the file without re-encoding (very fast)
        const ffmpegPath = '/opt/homebrew/bin/ffmpeg';
        const ffmpegCmd = `"${ffmpegPath}" -i "${tempFilePath}" -f segment -segment_time 300 -c copy "${outputPattern}"`;
        
        try {
          await execPromise(ffmpegCmd);
        } catch (ffmpegErr: any) {
          // Fallback to system 'ffmpeg' in case path is different
          try {
            await execPromise(`ffmpeg -i "${tempFilePath}" -f segment -segment_time 300 -c copy "${outputPattern}"`);
          } catch (innerErr: any) {
            // If copying streams fails, re-encode as a fallback
            console.warn('Stream copying failed, trying with re-encoding to AAC...', innerErr);
            extension = 'm4a';
            mimeType = 'audio/m4a';
            const reencodePattern = path.join(tempDir, `${chunkPrefix}-%03d.${extension}`);
            const reencodeCmd = `ffmpeg -i "${tempFilePath}" -f segment -segment_time 300 -c:a aac "${reencodePattern}"`;
            try {
              await execPromise(reencodeCmd);
            } catch (reencodeErr: any) {
              throw new Error(`FFmpeg failure: ${reencodeErr.message || innerErr.message}. Make sure ffmpeg is installed.`);
            }
          }
        }

        const files = await fs.promises.readdir(tempDir);
        chunkFiles = files
          .filter(f => f.startsWith(chunkPrefix) && f.endsWith(`.${extension}`))
          .sort()
          .map(f => path.join(tempDir, f));

        if (chunkFiles.length === 0) {
          throw new Error('Audio segmentation failed; no chunks created.');
        }

        sendProgress(`Segmented into ${chunkFiles.length} chunk(s). Starting translation...`, 20, 100);

        let fullTranscript = '';
        let previousContext = '';

        for (let i = 0; i < chunkFiles.length; i++) {
          const chunkPath = chunkFiles[i];
          const chunkNum = i + 1;
          
          sendProgress(
            `Translating segment ${chunkNum} of ${chunkFiles.length}...`,
            Math.round(20 + (chunkNum / chunkFiles.length) * 75),
            100
          );

          // Upload chunk using Gemini File API with correct MIME type
          const uploadResult = await ai.files.upload({
            file: chunkPath,
            config: {
              mimeType: mimeType,
            }
          });
          
          if (uploadResult.name) {
            uploadedFileNames.push(uploadResult.name);
          }

          // Prepare prompt with previous context for speaker diarization consistency
          const contextPrompt = previousContext 
            ? `Here is the end of the translation from the previous audio segment to maintain continuity:
---
${previousContext}
---
Please transcribe and translate the next audio segment. Ensure speaker labels (e.g. Speaker 1, Speaker 2) are matched correctly and consistently based on this previous context. If a new speaker appears, assign them the next number (e.g. Speaker 3).`
            : ``;

          const prompt = `You are a professional research-grade transcription and translation service.
Your task is to transcribe the Nepali audio, translate it into English, and format it as a dialogue between speakers (Speaker 1, Speaker 2, etc.).

Strict rules:
1. Translate EVERY spoken sentence. Never summarize, shorten, or skip any dialogue.
2. Maintain proper English grammar and punctuation.
3. If speech cannot be understood, output "[inaudible]" for fully unclear sections, or "[unclear]" for a single unclear word. Do not guess.
4. Format the output clearly as a script, starting a new line every time the speaker changes.
   Example:
   Speaker 1: Hello.
   Speaker 2: Hello, nice to meet you.
5. Preserve place names, proper names, emotional expressions, and incomplete sentences.

${contextPrompt}

Listen to the attached audio chunk and translate it now:`;

          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: uploadResult.uri,
                      mimeType: uploadResult.mimeType,
                    }
                  },
                  {
                    text: prompt
                  }
                ]
              }
            ]
          });

          const chunkText = response.text || '';
          fullTranscript += (fullTranscript ? '\n\n' : '') + chunkText.trim();

          // Get last few lines of this translation for the next segment's context
          const lines = chunkText.split('\n').filter(line => line.trim());
          previousContext = lines.slice(-4).join('\n');

          // Delete file from Google storage immediately to save space
          try {
            if (uploadResult.name) {
              await ai.files.delete({ name: uploadResult.name });
              uploadedFileNames = uploadedFileNames.filter(name => name !== uploadResult.name);
            }
          } catch (deleteErr) {
            console.error(`Failed to delete file ${uploadResult.name}:`, deleteErr);
          }

          // Delete local chunk file
          try {
            if (fs.existsSync(chunkPath)) {
              await fs.promises.unlink(chunkPath);
            }
          } catch (err) {
            console.error(`Failed to delete local chunk file ${chunkPath}:`, err);
          }
        }

        sendProgress('Finalizing translation transcript...', 98, 100);
        sendResult(fullTranscript);

      } catch (error: any) {
        console.error('Translation error in stream:', error);
        sendError(error.message || 'An unexpected error occurred during translation.');
      } finally {
        // Cleanup local source file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try {
            await fs.promises.unlink(tempFilePath);
          } catch (e) {
            console.error('Failed to delete temp source file:', e);
          }
        }

        // Cleanup local chunk files if any remain
        for (const chunkPath of chunkFiles) {
          if (fs.existsSync(chunkPath)) {
            try {
              await fs.promises.unlink(chunkPath);
            } catch (e) {
              console.error('Failed to delete chunk file in cleanup:', e);
            }
          }
        }

        // Cleanup uploaded files on Google servers if any remain
        if (ai && uploadedFileNames.length > 0) {
          for (const fileName of uploadedFileNames) {
            try {
              await ai.files.delete({ name: fileName });
            } catch (e) {
              console.error(`Failed to clean up Google file ${fileName}:`, e);
            }
          }
        }

        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
