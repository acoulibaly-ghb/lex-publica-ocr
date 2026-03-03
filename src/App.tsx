/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI } from "@google/genai";
import { 
  FileText, 
  Upload, 
  Copy, 
  Check, 
  Loader2, 
  AlertCircle, 
  Image as ImageIcon,
  FileSearch,
  Download,
  Trash2
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';
import * as pdfjsLib from 'pdfjs-dist';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface OCRResult {
  text: string;
  timestamp: number;
  fileName: string;
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<OCRResult | null>(null);
  const [history, setHistory] = useState<OCRResult[]>(() => {
    const saved = localStorage.getItem('ocr_history');
    return saved ? JSON.parse(saved) : [];
  });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showCitation, setShowCitation] = useState(false);
  const [citation, setCitation] = useState("");

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setError(null);
    setFiles(acceptedFiles);
    
    const newPreviews: string[] = [];
    let pageCount = 0;
    for (const file of acceptedFiles) {
      if (file.type === 'application/pdf') {
        try {
          const pdfPreviews = await generatePdfPreviews(file);
          newPreviews.push(...pdfPreviews);
          pageCount = pdfPreviews.length;
        } catch (err) {
          console.error("PDF Preview Error:", err);
          newPreviews.push(''); // Fallback or error placeholder
        }
      } else {
        newPreviews.push(URL.createObjectURL(file));
        pageCount = 1;
      }
    }
    setPreviews(newPreviews);
    setPdfPageCount(pageCount);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.webp'],
      'application/pdf': ['.pdf']
    },
    multiple: false
  });

  const generatePdfPreviews = async (file: File, maxPages: number = 20): Promise<string[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = Math.min(pdf.numPages, maxPages);
    const pagePreviews: string[] = [];

    // Reduce scale from 1.5 to 1.2 to save space while maintaining readability
    const scale = 1.2;

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      if (context) {
        // @ts-ignore - pdfjs-dist types can be tricky between versions
        await page.render({ canvasContext: context, viewport }).promise;
        
        // Use image/jpeg with 0.7 quality instead of image/png to significantly reduce size
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        if (dataUrl !== 'data:,' && dataUrl.length > 100) {
          pagePreviews.push(dataUrl);
        }
      }
    }
    
    if (pagePreviews.length === 0) {
      throw new Error("Aucune page n'a pu être convertie en image.");
    }
    return pagePreviews;
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const processOCR = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    setError(null);
    setResult(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const model = "gemini-3-flash-preview";
      
      const parts: any[] = [];

      if (files[0].type === 'application/pdf') {
        if (previews.length === 0) {
          throw new Error("Impossible de générer l'aperçu du PDF pour l'analyse.");
        }
        
        for (const preview of previews) {
          const base64Parts = preview.split(',');
          if (base64Parts.length >= 2) {
            const mimeMatch = base64Parts[0].match(/:(.*?);/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            parts.push({
              inlineData: {
                data: base64Parts[1],
                mimeType: mimeType
              }
            });
          }
        }
      } else {
        const base64Data = await fileToBase64(files[0]);
        if (base64Data) {
          parts.push({
            inlineData: {
              data: base64Data,
              mimeType: files[0].type
            }
          });
        }
      }

      if (parts.length === 0) {
        throw new Error("Les données du document sont corrompues ou manquantes.");
      }

      console.log("Processing OCR with", parts.length, "pages/images");

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            ...parts,
            {
              text: "Extract all text from these document pages accurately. Maintain the structure and formatting as much as possible. If it's a legal document, preserve the layout of articles, dates, and signatures. Output only the extracted text in Markdown format. If there are multiple pages, combine them into a single continuous document."
            }
          ]
        },
        config: {
          systemInstruction: "You are an expert OCR assistant specialized in legal and historical documents. Your goal is to provide highly accurate text extraction, preserving the original document's structure, including tables, lists, and headings. Do not add commentary unless necessary to clarify illegible parts. When multiple pages are provided, treat them as a single sequential document."
        }
      });

      if (response.text) {
        const newResult = {
          text: response.text,
          timestamp: Date.now(),
          fileName: files[0].name
        };
        setResult(newResult);
        const newHistory = [newResult, ...history].slice(0, 5);
        setHistory(newHistory);
        localStorage.setItem('ocr_history', JSON.stringify(newHistory));
      } else {
        throw new Error("Aucun texte n'a pu être extrait.");
      }
    } catch (err: any) {
      console.error("OCR Error:", err);
      setError(err.message || "Une erreur est survenue lors du traitement.");
    } finally {
      setIsProcessing(false);
    }
  };

  const copyToClipboard = () => {
    if (result) {
      navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const generateCitation = () => {
    if (result) {
      const date = new Date(result.timestamp).getFullYear();
      const baseName = result.fileName.replace(/\.[^/.]+$/, "").replace(/_/g, " ");
      const formatted = `Source : ${baseName} (Extrait via Légiscribe OCR, ${date})`;
      setCitation(formatted);
      setShowCitation(true);
    }
  };

  const downloadText = () => {
    if (result) {
      const blob = new Blob([result.text], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${result.fileName.split('.')[0]}_ocr.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const reset = () => {
    setFiles([]);
    setPreviews([]);
    setResult(null);
    setError(null);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('ocr_history');
  };

  const loadFromHistory = (item: OCRResult) => {
    setResult(item);
    // Scroll to results on mobile
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg">
            <FileSearch className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 tracking-tight">Légiscribe OCR</h1>
            <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Assistant de transcription juridique</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs font-mono text-zinc-400 bg-zinc-100 px-2 py-1 rounded">v1.0.0</span>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column: Input */}
        <div className="space-y-6">
          <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
            <div className="p-4 border-b border-zinc-100 bg-zinc-50/50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
                <Upload className="w-4 h-4" />
                Document Source
              </h2>
              {files.length > 0 && (
                <button 
                  onClick={reset}
                  className="text-xs text-red-600 hover:text-red-700 font-medium flex items-center gap-1 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  Réinitialiser
                </button>
              )}
            </div>
            
            <div className="p-6">
              {files.length === 0 ? (
                <div 
                  {...getRootProps()} 
                  className={cn(
                    "border-2 border-dashed rounded-xl p-12 flex flex-col items-center justify-center text-center transition-all cursor-pointer",
                    isDragActive ? "border-indigo-500 bg-indigo-50/50" : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                  )}
                >
                  <input {...getInputProps()} />
                  <div className="bg-zinc-100 p-4 rounded-full mb-4">
                    <Upload className="w-8 h-8 text-zinc-400" />
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-900 mb-1">
                    {isDragActive ? "Déposez le fichier ici" : "Déposez un document ou cliquez pour parcourir"}
                  </h3>
                  <p className="text-xs text-zinc-500 max-w-xs">
                    Prend en charge les images (JPG, PNG, WebP) et les PDF (jusqu'à 20 pages). Idéal pour les archives Gallica.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="relative aspect-[3/4] bg-zinc-100 rounded-xl overflow-hidden border border-zinc-200 group">
                    {previews[0] ? (
                      <img 
                        src={previews[0]} 
                        alt="Preview" 
                        className="w-full h-full object-contain"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400">
                        <FileText className="w-12 h-12 mb-2" />
                        <span className="text-xs font-medium">Aperçu non disponible</span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4 opacity-0 group-hover:opacity-100 transition-opacity flex justify-between items-end">
                      <p className="text-white text-xs font-medium truncate flex-1 mr-2">{files[0].name}</p>
                      {pdfPageCount > 1 && (
                        <span className="bg-white/20 backdrop-blur-md text-white text-[10px] px-2 py-0.5 rounded-full border border-white/30">
                          {pdfPageCount} pages
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <button
                    onClick={processOCR}
                    disabled={isProcessing}
                    className={cn(
                      "w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-sm",
                      isProcessing 
                        ? "bg-zinc-100 text-zinc-400 cursor-not-allowed" 
                        : "bg-indigo-600 text-white hover:bg-indigo-700 active:scale-[0.98]"
                    )}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Transcription ({pdfPageCount} {pdfPageCount > 1 ? 'pages' : 'page'})...
                      </>
                    ) : (
                      <>
                        <FileSearch className="w-4 h-4" />
                        Lancer l'OCR
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </section>

          {error && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-red-900">Erreur</h4>
                <p className="text-xs text-red-700 mt-1">{error}</p>
              </div>
            </div>
          )}

          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
            <h4 className="text-sm font-semibold text-indigo-900 flex items-center gap-2 mb-2">
              <ImageIcon className="w-4 h-4" />
              Conseil Gallica
            </h4>
            <p className="text-xs text-indigo-700 leading-relaxed">
              Pour de meilleurs résultats, utilisez des captures d'écran haute résolution. Si vous rencontrez une erreur de taille avec un PDF long, essayez de le traiter par tranches de 5 à 10 pages.
            </p>
          </div>

          {history.length > 0 && (
            <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-zinc-100 bg-zinc-50/50 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
                  <FileSearch className="w-4 h-4" />
                  Historique Récent
                </h2>
                <button 
                  onClick={clearHistory}
                  className="text-[10px] text-zinc-400 hover:text-red-500 font-medium transition-colors"
                >
                  Effacer
                </button>
              </div>
              <div className="divide-y divide-zinc-100">
                {history.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => loadFromHistory(item)}
                    className="w-full p-4 text-left hover:bg-zinc-50 transition-colors flex items-center justify-between group"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-zinc-900 truncate">{item.fileName}</p>
                      <p className="text-[10px] text-zinc-400 mt-0.5">
                        {new Date(item.timestamp).toLocaleDateString('fr-FR')} • {item.text.length} caractères
                      </p>
                    </div>
                    <FileText className="w-4 h-4 text-zinc-300 group-hover:text-indigo-500 transition-colors shrink-0 ml-4" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right Column: Results */}
        <div className="space-y-6">
          <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm h-full flex flex-col min-h-[600px]">
            <div className="p-4 border-b border-zinc-100 bg-zinc-50/50 flex items-center justify-between shrink-0">
              <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Texte Extrait
              </h2>
              {result && (
                <div className="flex items-center gap-2">
                  <button 
                    onClick={generateCitation}
                    className="p-2 hover:bg-indigo-50 rounded-lg transition-colors text-indigo-600 relative group"
                    title="Générer citation"
                  >
                    <FileSearch className="w-4 h-4" />
                    <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-zinc-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                      Citer
                    </span>
                  </button>
                  <button 
                    onClick={copyToClipboard}
                    className="p-2 hover:bg-zinc-200 rounded-lg transition-colors text-zinc-600 relative group"
                    title="Copier le texte"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                    <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-zinc-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                      {copied ? 'Copié !' : 'Copier'}
                    </span>
                  </button>
                  <button 
                    onClick={downloadText}
                    className="p-2 hover:bg-zinc-200 rounded-lg transition-colors text-zinc-600 relative group"
                    title="Télécharger .md"
                  >
                    <Download className="w-4 h-4" />
                    <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-zinc-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                      Télécharger (.md)
                    </span>
                  </button>
                </div>
              )}
            </div>
            
            <div className="flex-1 p-6 overflow-y-auto relative">
              {showCitation && (
                <div className="mb-6 p-3 bg-indigo-50 border border-indigo-100 rounded-lg animate-in fade-in zoom-in duration-300">
                  <div className="flex justify-between items-start mb-1">
                    <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest">Référence suggérée</span>
                    <button onClick={() => setShowCitation(false)} className="text-indigo-400 hover:text-indigo-600">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-xs font-serif italic text-indigo-900">{citation}</p>
                </div>
              )}

              {!result && !isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 p-8 text-center">
                  <div className="bg-zinc-50 p-6 rounded-full mb-4">
                    <FileText className="w-12 h-12 opacity-20" />
                  </div>
                  <p className="text-sm font-medium">Le texte extrait apparaîtra ici après le traitement.</p>
                  <p className="text-xs mt-2 max-w-[240px]">Chargez un document et cliquez sur "Lancer l'OCR" pour commencer.</p>
                </div>
              )}

              {isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm z-10">
                  <div className="relative">
                    <Loader2 className="w-12 h-12 text-indigo-600 animate-spin" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-2 h-2 bg-indigo-600 rounded-full animate-ping" />
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-zinc-900 mt-4">Analyse du document...</p>
                  <p className="text-xs text-zinc-500 mt-1">Gemini extrait les caractères et la structure.</p>
                </div>
              )}

              {result && (
                <div className="markdown-body animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <Markdown>{result.text}</Markdown>
                </div>
              )}
            </div>

            {result && (
              <div className="p-4 border-t border-zinc-100 bg-zinc-50/30 shrink-0">
                <p className="text-[10px] text-zinc-400 font-mono text-center">
                  Extrait le {new Date(result.timestamp).toLocaleString('fr-FR')} • Source: {result.fileName}
                </p>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-zinc-200 px-6 py-4 text-center">
        <p className="text-xs text-zinc-500">
          Propulsé par Gemini 3 Flash • Optimisé pour les documents juridiques et archives historiques.
        </p>
      </footer>
    </div>
  );
}
