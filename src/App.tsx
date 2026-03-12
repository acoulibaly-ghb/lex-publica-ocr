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
  Languages,
  FileDown
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';
import * as pdfjsLib from 'pdfjs-dist';

// Bibliothèques pour l'export
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { jsPDF } from 'jspdf';
import { saveAs } from 'file-saver';

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
        
        previews.forEach((preview, index) => {
          const isOdd = index % 2 === 0;
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

      if (parts.length === 0) throw new Error("Aucune page sélectionnée.");

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            ...parts,
            { text: "Extract all text from these document pages accurately. Maintain structure. Preserve articles, dates, and signatures. Output only Markdown. Combine pages." }
          ]
        },
        config: {
          systemInstruction: "You are an expert legal OCR assistant. Provide high-fidelity text extraction. Keep original headings and layout. Output sequence as one document."
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

  // LOGIQUE D'EXPORT MULTI-FORMAT
  const downloadAsFormat = async (format: 'md' | 'docx' | 'pdf') => {
    if (!result) return;
    const baseFileName = `${result.fileName.split('.')[0]}_transcription`;

    if (format === 'md') {
      const blob = new Blob([result.text], { type: 'text/markdown' });
      saveAs(blob, `${baseFileName}.md`);
    } 
    
    else if (format === 'docx') {
      const doc = new Document({
        sections: [{
          properties: {},
          children: result.text.split('\n').map(line => 
            new Paragraph({
              children: [new TextRun({ text: line, font: "Times New Roman", size: 24 })],
              spacing: { after: 200 }
            })
          ),
        }],
      });
      const blob = await Packer.toBlob(doc);
      saveAs(blob, `${baseFileName}.docx`);
    } 
    
    else if (format === 'pdf') {
      const doc = new jsPDF();
      const splitText = doc.splitTextToSize(result.text, 180);
      doc.setFont("times", "normal");
      doc.setFontSize(11);
      doc.text(splitText, 15, 20);
      doc.save(`${baseFileName}.pdf`);
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
          <div className="bg-[#1A2B4B] p-2.5 rounded-lg shadow-inner">
            <FileSearch className="w-6 h-6 text-[#D4AF37]" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-bold text-[#1A2B4B] tracking-tight">Légiscribe OCR</h1>
            <p className="text-[10px] text-[#D4AF37] font-bold uppercase tracking-[0.2em]">Assistant de transcription juridique</p>
          </div>
        </div>
        <div className="bg-zinc-50 border border-zinc-100 rounded-full px-3 py-1 flex items-center gap-2">
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Serveur Actif</span>
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
                <div {...getRootProps()} className={cn("border-2 border-dashed rounded-2xl p-16 flex flex-col items-center text-center cursor-pointer transition-all", isDragActive ? "border-[#D4AF37] bg-[#FDFCF9]" : "border-zinc-100 hover:border-[#D4AF37]/50")}>
                  <input {...getInputProps()} />
                  <div className="bg-zinc-50 p-5 rounded-full mb-6">
                    <Upload className="w-10 h-10 text-zinc-300" />
                  </div>
                  <h3 className="text-base font-serif font-bold text-[#1A2B4B] mb-2">Déposez un document CPJI ou Gallica</h3>
                  <p className="text-xs text-zinc-400 max-w-xs leading-relaxed">Images (JPG, PNG) ou PDF.<br/>Filtrage bilingue automatique disponible.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="relative aspect-[3/4] bg-[#FDFCF9] rounded-2xl overflow-hidden border border-zinc-100 shadow-inner group">
                    {previews[0] ? (
                      <img src={previews[0]} alt="Preview" className="w-full h-full object-contain p-4" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-zinc-300">Génération de l'aperçu...</div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#1A2B4B]/90 to-transparent p-6 flex justify-between items-end">
                      <p className="text-white text-xs font-medium truncate flex-1 mr-4">{files[0].name}</p>
                      <span className="bg-[#D4AF37] text-[#1A2B4B] text-[10px] font-bold px-3 py-1 rounded-full">{pdfPageCount} PAGES</span>
                    </div>
                  </div>

                  {/* SÉLECTEUR DE MODE CPJI */}
                  {pdfPageCount > 1 && (
                    <div className="space-y-3 bg-[#FDFCF9] p-4 rounded-xl border border-zinc-100 shadow-inner">
                      <label className="text-[10px] font-bold text-[#1A2B4B] uppercase tracking-widest flex items-center gap-2">
                        <Languages className="w-3.5 h-3.5 text-[#D4AF37]" /> Structure du document bilingue
                      </label>
                      <div className="flex bg-zinc-200/50 p-1 rounded-lg gap-1">
                        {(['all', 'fr', 'en'] as ExtractionMode[]).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => setExtractionMode(mode)}
                            className={cn(
                              "flex-1 py-2 text-[10px] font-bold uppercase rounded-md transition-all",
                              extractionMode === mode ? "bg-white shadow-sm text-[#1A2B4B]" : "text-zinc-500 hover:text-zinc-700"
                            )}
                          >
                            {mode === 'all' ? 'Complet' : mode === 'fr' ? 'FR (1, 3, 5...)' : 'EN (2, 4, 6...)'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  <button
                    onClick={processOCR}
                    disabled={isProcessing}
                    className={cn("w-full py-4 rounded-xl font-serif font-bold text-base flex items-center justify-center gap-3 transition-all shadow-md", isProcessing ? "bg-zinc-100 text-zinc-400" : "bg-[#1A2B4B] text-white hover:bg-[#243B6B] active:scale-[0.98]")}
                  >
                    {isProcessing ? <><Loader2 className="w-5 h-5 animate-spin" /> Analyse du manuscrit...</> : <><FileSearch className="w-5 h-5 text-[#D4AF37]" /> Lancer la Transcription</>}
                  </button>
                </div>
              )}
            </div>
          </section>

          <div className="bg-[#1A2B4B] border-l-4 border-[#D4AF37] rounded-r-2xl p-5 shadow-sm">
            <h4 className="text-xs font-bold text-[#D4AF37] uppercase tracking-widest flex items-center gap-2 mb-2">
              <ImageIcon className="w-3.5 h-3.5" /> Note de Recherche
            </h4>
            <p className="text-xs text-zinc-300 leading-relaxed font-serif italic">
              "Le mode bilingue optimise l'extraction en ignorant les pages miroirs, idéal pour les archives de la CPJI entre 1922 et 1946."
            </p>
          </div>
        </div>

        <div className="space-y-8">
          <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm flex flex-col min-h-[700px]">
            <div className="p-5 border-b border-zinc-100 bg-[#FDFCF9] flex items-center justify-between shrink-0">
              <h2 className="text-sm font-serif font-bold text-[#1A2B4B] flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#D4AF37]" /> Transcription du Folio
              </h2>
              {result && (
                <div className="flex items-center gap-3">
                  <button onClick={generateCitation} className="p-2 hover:bg-zinc-100 rounded-lg text-zinc-500 transition-colors" title="Citer">
                    <FileSearch className="w-4 h-4 text-[#D4AF37]" />
                  </button>
                  <button onClick={copyToClipboard} className="p-2 hover:bg-zinc-100 rounded-lg text-zinc-500 transition-colors" title="Copier">
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                  
                  {/* BOUTONS D'EXPORT */}
                  <div className="h-6 w-px bg-zinc-200 mx-1" />
                  <div className="flex bg-zinc-50 p-1 rounded-lg border border-zinc-100 gap-1">
                    <button onClick={() => downloadAsFormat('md')} className="px-2 py-1 text-[9px] font-black text-zinc-400 hover:text-[#1A2B4B] hover:bg-white rounded transition-all">MD</button>
                    <button onClick={() => downloadAsFormat('docx')} className="px-2 py-1 text-[9px] font-black text-zinc-400 hover:text-[#1A2B4B] hover:bg-white rounded transition-all">DOCX</button>
                    <button onClick={() => downloadAsFormat('pdf')} className="px-2 py-1 text-[9px] font-black text-zinc-400 hover:text-[#1A2B4B] hover:bg-white rounded transition-all">PDF</button>
                  </div>
                </div>
              )}
            </div>
            
            <div className="flex-1 p-10 overflow-y-auto relative bg-[#FDFCF9]/30">
              {showCitation && (
                <div className="mb-8 p-5 bg-[#1A2B4B] border-l-4 border-[#D4AF37] rounded-r-xl shadow-md text-white animate-in slide-in-from-top-4 duration-500">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[9px] font-bold text-[#D4AF37] uppercase tracking-widest">Référence Bibliographique</span>
                    <button onClick={() => setShowCitation(false)}><Trash2 className="w-3 h-3 text-zinc-400 hover:text-white" /></button>
                  </div>
                  <p className="text-sm font-serif italic text-zinc-100">{citation}</p>
                </div>
              )}

              {isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm z-10">
                  <Loader2 className="w-12 h-12 animate-spin text-[#1A2B4B] opacity-20" />
                  <p className="text-sm font-serif font-bold text-[#1A2B4B] mt-4">Examen du corpus juridique...</p>
                </div>
              )}

              {result ? (
                <div className="markdown-body prose prose-zinc max-w-none">
                  <Markdown>{result.text}</Markdown>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-zinc-300 opacity-40 py-20">
                  <FileDown className="w-16 h-16 mb-4" />
                  <p className="text-base font-serif italic">Prêt pour la transcription...</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="bg-white border-t border-[#D4AF37]/10 px-8 py-6 text-center">
        <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-[0.3em]">Légiscribe OCR • Laboratoire de Recherche Juridique</p>
        <p className="text-[9px] text-zinc-300 italic font-serif mt-1">Multi-format Export Enabled (MD, DOCX, PDF)</p>
      </footer>
    </div>
  );
}
