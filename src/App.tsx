/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI } from "@google/genai";
import { 
  FileText, 
  Upload, 
  Copy, 
  Check, 
  Loader2, 
  Image as ImageIcon,
  FileSearch,
  Download,
  Trash2,
  Languages
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';
import * as pdfjsLib from 'pdfjs-dist';

// Configuration du worker PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface OCRResult {
  text: string;
  timestamp: number;
  fileName: string;
}

type ExtractionMode = 'all' | 'fr' | 'en';

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('all');
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
          console.error("Erreur d'aperçu PDF:", err);
          newPreviews.push('');
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

  const generatePdfPreviews = async (file: File, maxPages: number = 40): Promise<string[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = Math.min(pdf.numPages, maxPages);
    const pagePreviews: string[] = [];
    const scale = 1.2;

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      if (context) {
        // @ts-ignore
        await page.render({ canvasContext: context, viewport }).promise;
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        if (dataUrl !== 'data:,' && dataUrl.length > 100) {
          pagePreviews.push(dataUrl);
        }
      }
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
        if (previews.length === 0) throw new Error("Aperçu manquant.");
        
        // FILTRAGE BILINGUE : On filtre les pages selon le mode choisi
        previews.forEach((preview, index) => {
          const isOdd = index % 2 === 0; // Page 1, 3, 5... (index 0, 2, 4)
          
          if (extractionMode === 'fr' && !isOdd) return; 
          if (extractionMode === 'en' && isOdd) return;

          const base64Parts = preview.split(',');
          if (base64Parts.length >= 2) {
            parts.push({
              inlineData: {
                data: base64Parts[1],
                mimeType: 'image/jpeg'
              }
            });
          }
        });
      } else {
        const base64Data = await fileToBase64(files[0]);
        if (base64Data) {
          parts.push({
            inlineData: { data: base64Data, mimeType: files[0].type }
          });
        }
      }

      if (parts.length === 0) throw new Error("Aucune page sélectionnée pour l'analyse.");

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            ...parts,
            { text: "Extract all text from these document pages accurately. Maintain the structure and formatting. Preserve articles, dates, and signatures. Output only Markdown text. Combine pages into a single continuous document." }
          ]
        },
        config: {
          systemInstruction: "You are an expert OCR assistant for historical legal documents. Provide highly accurate text extraction. Maintain original structure (tables, headings). Sequential document output."
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
      }
    } catch (err: any) {
      setError(err.message || "Erreur de traitement.");
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
      setCitation(`Source : ${baseName} (Extrait via Légiscribe OCR, ${date})`);
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
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const reset = () => {
    setFiles([]);
    setPreviews([]);
    setResult(null);
    setError(null);
    setExtractionMode('all');
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      <header className="bg-white border-b border-[#D4AF37]/20 px-8 py-5 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="bg-[#1A2B4B] p-2.5 rounded-lg">
            <FileSearch className="w-6 h-6 text-[#D4AF37]" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-bold text-[#1A2B4B]">Légiscribe OCR</h1>
            <p className="text-[10px] text-[#D4AF37] font-bold uppercase tracking-[0.2em]">Assistant de transcription juridique</p>
          </div>
        </div>
        <div className="bg-zinc-50 border border-zinc-100 rounded-full px-3 py-1 flex items-center gap-2">
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
          <span className="text-[10px] font-bold text-zinc-400 uppercase">Serveur Actif</span>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="space-y-8">
          <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
            <div className="p-5 border-b border-zinc-100 bg-[#FDFCF9] flex items-center justify-between">
              <h2 className="text-sm font-serif font-bold text-[#1A2B4B] flex items-center gap-2">
                <Upload className="w-4 h-4 text-[#D4AF37]" /> Source du Document
              </h2>
              {files.length > 0 && (
                <button onClick={reset} className="text-[10px] text-zinc-400 hover:text-red-600 font-bold uppercase flex items-center gap-1.5 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" /> Réinitialiser
                </button>
              )}
            </div>
            
            <div className="p-8">
              {files.length === 0 ? (
                <div {...getRootProps()} className={cn("border-2 border-dashed rounded-2xl p-16 flex flex-col items-center text-center cursor-pointer", isDragActive ? "border-[#D4AF37] bg-[#FDFCF9]" : "border-zinc-100 hover:border-[#D4AF37]/50")}>
                  <input {...getInputProps()} />
                  <Upload className="w-10 h-10 text-zinc-300 mb-6" />
                  <h3 className="text-base font-serif font-bold text-[#1A2B4B] mb-2">Déposez un document ou cliquez</h3>
                  <p className="text-xs text-zinc-400 max-w-xs">PDF bilingues (CPJI) ou scans Gallica jusqu'à 20 pages.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="relative aspect-[3/4] bg-[#FDFCF9] rounded-2xl overflow-hidden border border-zinc-100 shadow-inner group">
                    {previews[0] ? (
                      <img src={previews[0]} alt="Preview" className="w-full h-full object-contain p-4" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-zinc-300">Chargement...</div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-[#1A2B4B]/80 p-4 flex justify-between items-center">
                      <p className="text-white text-[10px] truncate max-w-[150px]">{files[0].name}</p>
                      <span className="bg-[#D4AF37] text-[#1A2B4B] text-[10px] font-bold px-2 py-0.5 rounded-full">{pdfPageCount} PAGES</span>
                    </div>
                  </div>

                  {/* SÉLECTEUR DE MODE CPJI / BILINGUE */}
                  {pdfPageCount > 1 && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-[#1A2B4B] uppercase tracking-wider flex items-center gap-2">
                        <Languages className="w-3 h-3 text-[#D4AF37]" /> Mode d'extraction (Structure CPJI)
                      </label>
                      <div className="flex bg-zinc-100 p-1 rounded-xl gap-1">
                        {(['all', 'fr', 'en'] as ExtractionMode[]).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => setExtractionMode(mode)}
                            className={cn(
                              "flex-1 py-2 text-[10px] font-bold uppercase rounded-lg transition-all",
                              extractionMode === mode ? "bg-white shadow-sm text-[#1A2B4B]" : "text-zinc-400 hover:text-zinc-600"
                            )}
                          >
                            {mode === 'all' ? 'Complet' : mode === 'fr' ? 'Français (1,3,5...)' : 'Anglais (2,4,6...)'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  <button
                    onClick={processOCR}
                    disabled={isProcessing}
                    className={cn("w-full py-4 rounded-xl font-serif font-bold text-base flex items-center justify-center gap-3 transition-all shadow-md", isProcessing ? "bg-zinc-100 text-zinc-400" : "bg-[#1A2B4B] text-white hover:bg-[#243B6B]")}
                  >
                    {isProcessing ? <><Loader2 className="w-5 h-5 animate-spin" /> Analyse...</> : <><FileSearch className="w-5 h-5 text-[#D4AF37]" /> Lancer la Transcription</>}
                  </button>
                </div>
              )}
            </div>
          </section>

          <div className="bg-[#1A2B4B] border-l-4 border-[#D4AF37] rounded-r-2xl p-5">
            <h4 className="text-xs font-bold text-[#D4AF37] uppercase tracking-widest flex items-center gap-2 mb-2">
              <ImageIcon className="w-3.5 h-3.5" /> Note de Recherche
            </h4>
            <p className="text-xs text-zinc-300 leading-relaxed font-serif italic">
              "En mode bilingue, Légiscribe ignore automatiquement les pages de la langue opposée pour éviter les textes entrelacés."
            </p>
          </div>
        </div>

        <div className="space-y-8">
          <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm flex flex-col min-h-[700px]">
            <div className="p-5 border-b border-zinc-100 bg-[#FDFCF9] flex items-center justify-between">
              <h2 className="text-sm font-serif font-bold text-[#1A2B4B] flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#D4AF37]" /> Transcription du Folio
              </h2>
              {result && (
                <div className="flex items-center gap-2">
                  <button onClick={generateCitation} className="p-2 hover:bg-zinc-100 rounded-lg text-zinc-500"><FileSearch className="w-4 h-4 text-[#D4AF37]" /></button>
                  <button onClick={copyToClipboard} className="p-2 hover:bg-zinc-100 rounded-lg text-zinc-500">{copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}</button>
                  <button onClick={downloadText} className="p-2 hover:bg-zinc-100 rounded-lg text-zinc-500"><Download className="w-4 h-4" /></button>
                </div>
              )}
            </div>
            
            <div className="flex-1 p-10 overflow-y-auto relative bg-[#FDFCF9]/30">
              {showCitation && (
                <div className="mb-6 p-4 bg-[#1A2B4B] border-l-4 border-[#D4AF37] rounded-r-xl text-white">
                  <p className="text-sm font-serif italic">{citation}</p>
                </div>
              )}
              {isProcessing && <div className="absolute inset-0 flex items-center justify-center bg-white/80"><Loader2 className="w-10 h-10 animate-spin text-[#1A2B4B]" /></div>}
              {result ? <div className="markdown-body"><Markdown>{result.text}</Markdown></div> : <p className="text-center text-zinc-300 font-serif italic py-20">Le texte apparaîtra ici...</p>}
            </div>
          </section>
        </div>
      </main>

      <footer className="bg-white border-t border-[#D4AF37]/10 px-8 py-6 text-center">
        <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-[0.3em]">Légiscribe OCR • Laboratoire de Recherche Juridique</p>
      </footer>
    </div>
  );
}
