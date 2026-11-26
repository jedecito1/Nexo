/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookmarkCheck,
  BookmarkPlus,
  Calendar,
  Camera,
  Check,
  Copy,
  FileText,
  FolderOpen,
  Mic,
  MicOff,
  Search,
  Share2,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import type { IdiomaDestino, Tramite } from './types';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const IDIOMAS: Array<{ value: IdiomaDestino; label: string }> = [
  { value: 'Español', label: 'Español' },
  { value: 'Náhuatl', label: 'Náhuatl' },
  { value: 'Maya', label: 'Maya' },
  { value: 'English', label: 'English' },
  { value: 'Kreyòl Ayisyen', label: 'Kreyòl Ayisyen' },
];

const EJEMPLOS_RAPIDOS: Array<{ titulo: string; texto: string }> = [
  {
    titulo: 'Constancia de Situación Fiscal',
    texto: 'Me piden mi Constancia de Situación Fiscal actualizada en el trabajo y no sé qué es ni cómo sacarla.',
  },
  {
    titulo: 'Cita médica o vigencia de derechos',
    texto: 'Necesito saber cómo revisar si mi seguro médico sigue activo y qué papeles llevar a mi clínica.',
  },
  {
    titulo: 'Beca para estudiantes',
    texto: '¿Qué requisitos suelen pedir para inscribirse a una beca escolar y cómo preparo los documentos?',
  },
];

const OFFLINE_STORAGE_KEY = 'nexo_offline';

async function parseJsonSafe<T>(res: Response): Promise<T> {
  const raw = await res.text();
  const trimmed = raw.trim();
  const contentType = res.headers.get('content-type') || '';

  if (!contentType.includes('application/json') && (trimmed.startsWith('<!') || trimmed.startsWith('<html'))) {
    throw new Error(
      'El servidor devolvió una página HTML en lugar de datos. Recarga la página e intenta de nuevo.'
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      res.ok
        ? 'La respuesta del servidor no tiene un formato válido.'
        : `Error del servidor (${res.status}). Intenta de nuevo.`
    );
  }
}

async function compressImageFile(file: File): Promise<{ dataUrl: string; base64: string; mimeType: string }> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('No se pudo leer la foto seleccionada.'));
    reader.readAsDataURL(file);
  });

  if (file.size <= 1.5 * 1024 * 1024) {
    return {
      dataUrl: rawDataUrl,
      base64: rawDataUrl.split(',')[1] || '',
      mimeType: file.type || 'image/jpeg',
    };
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1600;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({
          dataUrl: rawDataUrl,
          base64: rawDataUrl.split(',')[1] || '',
          mimeType: file.type || 'image/jpeg',
        });
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const compressedUrl = canvas.toDataURL('image/jpeg', 0.84);
      resolve({
        dataUrl: compressedUrl,
        base64: compressedUrl.split(',')[1] || '',
        mimeType: 'image/jpeg',
      });
    };
    img.onerror = () => {
      resolve({
        dataUrl: rawDataUrl,
        base64: rawDataUrl.split(',')[1] || '',
        mimeType: file.type || 'image/jpeg',
      });
    };
    img.src = rawDataUrl;
  });
}

export default function App() {
  const [idioma, setIdioma] = useState<IdiomaDestino>('Español');
  const [texto, setTexto] = useState('');
  const [imagenPreview, setImagenPreview] = useState<string | null>(null);
  const [imagenBase64, setImagenBase64] = useState<string | null>(null);
  const [imagenMimeType, setImagenMimeType] = useState<string | null>(null);
  const [imagenNombre, setImagenNombre] = useState<string | null>(null);

  const [cargando, setCargando] = useState(false);
  const [escuchando, setEscuchando] = useState(false);
  const [leyendoVoz, setLeyendoVoz] = useState(false);
  const [textoGrande, setTextoGrande] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [avisoMsg, setAvisoMsg] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const [resultadoActual, setResultadoActual] = useState<Tramite | null>(null);
  const [guardados, setGuardados] = useState<Tramite[]>([]);
  const [cargandoGuardados, setCargandoGuardados] = useState(true);
  const [modoOffline, setModoOffline] = useState(false);
  const [busqueda, setBusqueda] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const resultSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void cargarGuardados();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      recognitionRef.current?.stop();
    };
  }, []);

  async function cargarGuardados() {
    setCargandoGuardados(true);
    try {
      const res = await fetch('/api/tramites');
      if (!res.ok) throw new Error('Error al leer guardados');
      const data = await parseJsonSafe<Tramite[]>(res);
      setGuardados(data);
      setModoOffline(false);
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(data));
      if (!resultadoActual && data.length > 0) {
        setResultadoActual(data[0]);
      }
    } catch {
      const locales = JSON.parse(localStorage.getItem(OFFLINE_STORAGE_KEY) || '[]') as Tramite[];
      setGuardados(locales);
      setModoOffline(true);
      if (!resultadoActual && locales.length > 0) {
        setResultadoActual(locales[0]);
      }
    } finally {
      setCargandoGuardados(false);
    }
  }

  function mostrarAviso(mensaje: string) {
    setAvisoMsg(mensaje);
    window.setTimeout(() => {
      setAvisoMsg((actual) => (actual === mensaje ? null : actual));
    }, 4000);
  }

  async function manejarFoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);

    if (!file.type.startsWith('image/')) {
      setErrorMsg('Por favor selecciona una foto en formato JPG, PNG o WEBP.');
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg('La foto es demasiado grande. Intenta tomarla un poco más alejada o elegir otra.');
      return;
    }

    try {
      const { dataUrl, base64, mimeType } = await compressImageFile(file);
      setImagenPreview(dataUrl);
      setImagenBase64(base64);
      setImagenMimeType(mimeType);
      setImagenNombre(file.name);
    } catch {
      setErrorMsg('No se pudo procesar la foto seleccionada.');
    }
  }

  function quitarFoto() {
    setImagenPreview(null);
    setImagenBase64(null);
    setImagenMimeType(null);
    setImagenNombre(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function alternarVoz() {
    setErrorMsg(null);
    if (escuchando) {
      recognitionRef.current?.stop();
      setEscuchando(false);
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErrorMsg('Tu navegador no permite dictado por voz. Puedes escribir tu duda o usar Chrome o Edge.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = idioma === 'English' ? 'en-US' : 'es-MX';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript ?? '';
      if (transcript) {
        setTexto((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
      setEscuchando(false);
    };

    recognition.onerror = () => {
      setEscuchando(false);
      setErrorMsg('No se pudo escuchar el micrófono. Revisa los permisos o escribe tu pregunta.');
    };

    recognition.onend = () => {
      setEscuchando(false);
    };

    recognitionRef.current = recognition;
    setEscuchando(true);
    recognition.start();
  }

  async function procesarConsulta(e?: React.FormEvent) {
    e?.preventDefault();
    setErrorMsg(null);
    setAvisoMsg(null);

    const textoLimpio = texto.trim();
    if (!textoLimpio && !imagenBase64) {
      setErrorMsg('Escribe una pregunta, dicta con tu voz o sube una foto del documento.');
      return;
    }

    detenerVozAlta();
    setCargando(true);

    try {
      const res = await fetch('/api/traducir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texto: textoLimpio,
          imagenBase64,
          mimeType: imagenMimeType,
          idiomaDestino: idioma,
        }),
      });

      const data = await parseJsonSafe<Tramite & { error?: string }>(res);
      if (!res.ok || data.error) {
        throw new Error(data.error || 'No se pudo procesar tu consulta.');
      }

      const nuevoResultado: Tramite = {
        ...data,
        idioma,
      };

      setResultadoActual(nuevoResultado);
      quitarFoto();
      window.setTimeout(() => {
        resultSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error de conexión con el servidor.';
      setErrorMsg(msg);
    } finally {
      setCargando(false);
    }
  }

  function leerEnVozAlta(velocidad: number) {
    if (!resultadoActual || !('speechSynthesis' in window)) {
      setErrorMsg('Tu navegador no admite lectura en voz alta.');
      return;
    }

    window.speechSynthesis.cancel();
    const pasosTexto = (resultadoActual.pasos ?? []).length > 0
      ? `Pasos a seguir: ${resultadoActual.pasos!.join('. ')}.`
      : '';
    const textoVoz =
      resultadoActual.texto_para_voz ||
      `${resultadoActual.titulo}. ${resultadoActual.que_es}. Fecha límite: ${resultadoActual.fecha_limite}. ${pasosTexto}`;

    const utterance = new SpeechSynthesisUtterance(textoVoz);
    utterance.lang = resultadoActual.idioma === 'English' ? 'en-US' : 'es-MX';
    utterance.rate = velocidad;
    utterance.onend = () => setLeyendoVoz(false);
    utterance.onerror = () => setLeyendoVoz(false);
    setLeyendoVoz(true);
    window.speechSynthesis.speak(utterance);
  }

  function detenerVozAlta() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setLeyendoVoz(false);
  }

  async function toggleRequisito(index: number) {
    if (!resultadoActual) return;

    const requisitosActualizados = resultadoActual.requisitos.map((req, idx) =>
      idx === index ? { ...req, listo: !req.listo } : req
    );

    const tramiteActualizado: Tramite = {
      ...resultadoActual,
      requisitos: requisitosActualizados,
    };

    setResultadoActual(tramiteActualizado);

    if (tramiteActualizado.id) {
      const listaActualizada = guardados.map((item) =>
        item.id === tramiteActualizado.id ? tramiteActualizado : item
      );
      setGuardados(listaActualizada);
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(listaActualizada));

      try {
        await fetch(`/api/tramites/${encodeURIComponent(tramiteActualizado.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requisitos: requisitosActualizados }),
        });
      } catch {
        setModoOffline(true);
      }
    }
  }

  async function guardarOffline() {
    if (!resultadoActual) return;
    setErrorMsg(null);

    if (resultadoActual.id) {
      mostrarAviso('Este trámite ya está guardado en tu carpeta.');
      return;
    }

    const borradorLocal: Tramite = {
      ...resultadoActual,
      id: `local-${Date.now()}`,
      creado_en: new Date().toISOString(),
    };

    try {
      const res = await fetch('/api/tramites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resultadoActual),
      });
      const data = await parseJsonSafe<{ tramite: Tramite; error?: string }>(res);
      if (!res.ok || data.error) {
        throw new Error(data.error || 'No se pudo guardar en el servidor');
      }
      const guardadoServidor: Tramite = data.tramite;
      const nuevaLista = [guardadoServidor, ...guardados];
      setGuardados(nuevaLista);
      setResultadoActual(guardadoServidor);
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(nuevaLista));
      setModoOffline(false);
      mostrarAviso('Guardado correctamente. Puedes consultarlo incluso sin internet.');
    } catch {
      const nuevaLista = [borradorLocal, ...guardados];
      setGuardados(nuevaLista);
      setResultadoActual(borradorLocal);
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(nuevaLista));
      setModoOffline(true);
      mostrarAviso('Guardado en este dispositivo para consultarlo sin internet.');
    }
  }

  async function eliminarGuardado(id: string | undefined, event: React.MouseEvent) {
    event.stopPropagation();
    if (!id) return;

    const siguienteLista = guardados.filter((item) => item.id !== id);
    setGuardados(siguienteLista);
    localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(siguienteLista));

    if (resultadoActual?.id === id) {
      setResultadoActual(siguienteLista[0] ?? null);
    }

    try {
      await fetch(`/api/tramites/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      mostrarAviso('Trámite eliminado de tu carpeta.');
    } catch {
      mostrarAviso('Eliminado de este dispositivo.');
    }
  }

  const mensajeCompartir = useMemo(() => {
    if (!resultadoActual) return '';
    const lista = (resultadoActual.requisitos || []).map((r) => `- ${r.texto}`).join('\n');
    const pasos = (resultadoActual.pasos || []).map((p, i) => `${i + 1}. ${p}`).join('\n');
    return `Hola, revisé este trámite en Nexo y necesito apoyo:\n\n${resultadoActual.titulo}\n${resultadoActual.que_es}\n\nFecha límite: ${resultadoActual.fecha_limite}${pasos ? `\n\nPasos:\n${pasos}` : ''}\n\nPapeles necesarios:\n${lista}`;
  }, [resultadoActual]);

  const whatsappHref = useMemo(() => {
    return `https://wa.me/?text=${encodeURIComponent(mensajeCompartir)}`;
  }, [mensajeCompartir]);

  async function copiarResumen() {
    if (!mensajeCompartir) return;
    try {
      await navigator.clipboard.writeText(mensajeCompartir);
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 2500);
    } catch {
      setErrorMsg('No se pudo copiar automáticamente al portapapeles.');
    }
  }

  const guardadosFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return guardados;
    return guardados.filter(
      (item) =>
        item.titulo.toLowerCase().includes(q) ||
        item.que_es.toLowerCase().includes(q) ||
        (item.idioma || '').toLowerCase().includes(q)
    );
  }, [guardados, busqueda]);

  const baseTextClass = textoGrande ? 'text-[19px] leading-relaxed' : 'text-[16px] leading-relaxed';

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      {/* Top Bar: strict 3-zone contract */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#explicar"
            className="text-xl font-extrabold tracking-tight text-blue-800 whitespace-nowrap shrink-0"
          >
            Nexo
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a href="#explicar" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Explicar trámite
            </a>
            <a href="#resultado" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Lectura fácil
            </a>
            <a href="#guardados" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Mis guardados
            </a>
            <a href="#como-funciona" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Cómo funciona
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <label htmlFor="idiomaSelect" className="sr-only">
              Idioma de explicación
            </label>
            <select
              id="idiomaSelect"
              value={idioma}
              onChange={(e) => setIdioma(e.target.value as IdiomaDestino)}
              className="min-h-[44px] px-3 py-2 text-sm font-semibold text-blue-900 bg-white border border-slate-300 rounded-xl hover:border-blue-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {IDIOMAS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        {/* Intro Strip */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200 pb-6">
          <div className="space-y-1.5 max-w-2xl">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-950 [text-wrap:balance]">
              Entiende cualquier trámite en palabras simples y en tu idioma
            </h1>
            <p className="text-slate-600 text-base sm:text-lg">
              Pega un aviso oficial, dicta tu duda con tu voz o toma una foto del papel. Te explicamos qué es, qué papeles necesitas y qué pasos seguir.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-xl shrink-0 self-start md:self-auto">
            <button
              type="button"
              onClick={() => setTextoGrande(false)}
              className={`min-h-[40px] px-3 py-1.5 text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                !textoGrande ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Letra normal
            </button>
            <button
              type="button"
              onClick={() => setTextoGrande(true)}
              className={`min-h-[40px] px-3 py-1.5 text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                textoGrande ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Letra grande
            </button>
          </div>
        </section>

        {/* Inline Alerts */}
        {errorMsg && (
          <div
            role="alert"
            className="bg-red-50 border border-red-200 text-red-900 rounded-2xl px-4 py-3.5 flex items-center justify-between gap-4"
          >
            <p className="font-medium text-sm sm:text-base">{errorMsg}</p>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              aria-label="Cerrar aviso de error"
              className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg hover:bg-red-100 text-red-800 shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        {avisoMsg && (
          <div
            role="status"
            className="bg-emerald-50 border border-emerald-200 text-emerald-950 rounded-2xl px-4 py-3.5 flex items-center justify-between gap-4"
          >
            <p className="font-medium text-sm sm:text-base">{avisoMsg}</p>
            <button
              type="button"
              onClick={() => setAvisoMsg(null)}
              aria-label="Cerrar notificación"
              className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg hover:bg-emerald-100 text-emerald-800 shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Two-column Workspace */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {/* Left Column: Input + Result */}
          <div className="lg:col-span-7 space-y-6">
            {/* Input Card */}
            <section
              id="explicar"
              className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-4"
            >
              <form onSubmit={procesarConsulta} className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="inputTexto" className="block font-semibold text-slate-900 text-lg">
                    1. Escribe tu duda, pega el texto o sube una foto
                  </label>
                  <textarea
                    id="inputTexto"
                    rows={4}
                    value={texto}
                    onChange={(e) => setTexto(e.target.value)}
                    placeholder="Ejemplo: Me piden una constancia de situación fiscal y no entiendo qué es o dónde se saca..."
                    className={`w-full p-3.5 border border-slate-300 rounded-xl bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-700 ${baseTextClass}`}
                  />
                </div>

                {/* Quick Example Prompts */}
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-500">
                    Ejemplos rápidos para probar:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {EJEMPLOS_RAPIDOS.map((ej) => (
                      <button
                        key={ej.titulo}
                        type="button"
                        onClick={() => {
                          setTexto(ej.texto);
                          setErrorMsg(null);
                        }}
                        className="min-h-[40px] px-3 py-1.5 text-xs sm:text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                      >
                        {ej.titulo}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Image Preview if selected */}
                {imagenPreview && (
                  <div className="flex items-center justify-between gap-4 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    <div className="flex items-center gap-3 min-w-0">
                      <img
                        src={imagenPreview}
                        alt="Vista previa del documento"
                        referrerPolicy="no-referrer"
                        className="w-16 h-16 object-cover rounded-lg border border-slate-200 shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">
                          {imagenNombre || 'Documento adjunto'}
                        </p>
                        <p className="text-xs text-slate-500">
                          Listo para leer y explicar en palabras simples
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={quitarFoto}
                      aria-label="Quitar foto"
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-600 hover:bg-slate-200 shrink-0"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                )}

                {/* Voice & Camera Controls */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={alternarVoz}
                    className={`min-h-[54px] px-4 py-3 rounded-xl font-bold flex items-center justify-center gap-2.5 transition-colors whitespace-nowrap shrink-0 ${
                      escuchando
                        ? 'bg-red-600 hover:bg-red-700 text-white'
                        : 'bg-amber-400 hover:bg-amber-500 text-slate-950'
                    }`}
                  >
                    {escuchando ? (
                      <>
                        <MicOff className="w-5 h-5 shrink-0" />
                        <span>Detener voz</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-5 h-5 shrink-0" />
                        <span>Hablar con tu voz</span>
                      </>
                    )}
                  </button>

                  <label className="min-h-[54px] px-4 py-3 rounded-xl font-bold bg-emerald-700 hover:bg-emerald-800 text-white flex items-center justify-center gap-2.5 cursor-pointer transition-colors whitespace-nowrap shrink-0">
                    <Camera className="w-5 h-5 shrink-0" />
                    <span>Foto de documento</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={manejarFoto}
                      className="sr-only"
                    />
                  </label>
                </div>

                {/* Primary CTA */}
                <button
                  type="submit"
                  disabled={cargando}
                  className="w-full min-h-[56px] px-5 py-3.5 bg-blue-700 hover:bg-blue-800 disabled:bg-blue-400 text-white font-bold text-base sm:text-lg rounded-xl transition-colors flex items-center justify-center gap-2.5 cursor-pointer"
                >
                  {cargando ? (
                    <span>Leyendo y preparando explicación sencilla...</span>
                  ) : (
                    <>
                      <FileText className="w-5 h-5 shrink-0" />
                      <span>Explicar en palabras simples</span>
                    </>
                  )}
                </button>
              </form>
            </section>

            {/* Loading Skeleton */}
            {cargando && (
              <section
                aria-busy="true"
                className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4"
              >
                <div className="h-7 w-2/3 bg-slate-200 rounded-lg animate-pulse" />
                <div className="h-20 w-full bg-slate-100 rounded-xl animate-pulse" />
                <div className="h-14 w-full bg-slate-100 rounded-xl animate-pulse" />
                <div className="space-y-2">
                  <div className="h-12 w-full bg-slate-100 rounded-xl animate-pulse" />
                  <div className="h-12 w-full bg-slate-100 rounded-xl animate-pulse" />
                </div>
              </section>
            )}

            {/* Result Card */}
            {!cargando && resultadoActual && (
              <section
                id="resultado"
                ref={resultSectionRef}
                className="bg-white rounded-2xl border border-blue-200 p-5 sm:p-6 space-y-6"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-slate-100 pb-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>Lectura fácil</span>
                      <span aria-hidden="true">·</span>
                      <span>Idioma: {resultadoActual.idioma || idioma}</span>
                      {resultadoActual.id && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Guardado</span>
                        </>
                      )}
                    </div>
                    <h2 className="text-xl sm:text-2xl font-bold text-slate-950 [text-wrap:balance]">
                      {resultadoActual.titulo}
                    </h2>
                  </div>

                  {/* Audio Playback Controls */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => leerEnVozAlta(0.95)}
                      className="min-h-[44px] px-3.5 py-2 bg-blue-50 hover:bg-blue-100 text-blue-900 font-semibold text-sm rounded-xl border border-blue-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                    >
                      <Volume2 className="w-4 h-4 shrink-0" />
                      <span>Escuchar</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => leerEnVozAlta(0.7)}
                      className="min-h-[44px] px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-sm rounded-xl border border-slate-200 whitespace-nowrap shrink-0 transition-colors"
                    >
                      Más lento
                    </button>
                    {leyendoVoz && (
                      <button
                        type="button"
                        onClick={detenerVozAlta}
                        aria-label="Detener lectura en voz alta"
                        className="min-h-[44px] min-w-[44px] px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-1.5 shrink-0 transition-colors"
                      >
                        <Square className="w-4 h-4 shrink-0" />
                      </button>
                    )}
                  </div>
                </div>

                {/* ¿Qué es? */}
                <div className="bg-slate-50 border border-slate-200/80 p-4 rounded-xl space-y-1.5">
                  <h3 className="text-sm font-bold text-blue-900">¿Qué es este trámite?</h3>
                  <p className={`text-slate-900 ${baseTextClass}`}>{resultadoActual.que_es}</p>
                </div>

                {/* Fecha límite */}
                <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start gap-3">
                  <Calendar className="w-5 h-5 text-amber-800 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-bold text-amber-950">Fecha límite</h3>
                    <p className={`text-slate-900 font-medium mt-0.5 ${baseTextClass}`}>
                      {resultadoActual.fecha_limite || 'Sin fecha límite especificada'}
                    </p>
                  </div>
                </div>

                {/* Pasos para realizarlo */}
                {resultadoActual.pasos && resultadoActual.pasos.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="text-base font-bold text-slate-900">
                      ¿Cómo realizarlo paso a paso?
                    </h3>
                    <ol className="space-y-2.5">
                      {resultadoActual.pasos.map((paso, idx) => (
                        <li
                          key={idx}
                          className="flex items-start gap-3 p-3.5 bg-slate-50 rounded-xl border border-slate-200/80"
                        >
                          <span className="w-7 h-7 rounded-lg bg-blue-700 text-white font-bold text-sm flex items-center justify-center shrink-0 tabular-nums">
                            {idx + 1}
                          </span>
                          <span className={`text-slate-900 ${baseTextClass}`}>{paso}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* Requisitos Checklist */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-slate-900">Lo que necesitas llevar</h3>
                    <span className="text-xs font-medium text-slate-500 tabular-nums">
                      {resultadoActual.requisitos.filter((r) => r.listo).length} de{' '}
                      {resultadoActual.requisitos.length} listos
                    </span>
                  </div>

                  {resultadoActual.requisitos.length === 0 ? (
                    <p className="text-sm text-slate-600 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                      No se mencionaron documentos o requisitos específicos en esta consulta.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {resultadoActual.requisitos.map((req, idx) => (
                        <li key={idx}>
                          <label className="min-h-[52px] flex items-center gap-3.5 p-3.5 bg-slate-50 hover:bg-slate-100/80 rounded-xl border border-slate-200 cursor-pointer transition-colors">
                            <input
                              type="checkbox"
                              checked={req.listo}
                              onChange={() => void toggleRequisito(idx)}
                              className="w-6 h-6 accent-blue-700 rounded shrink-0 cursor-pointer"
                            />
                            <span
                              className={`${baseTextClass} ${
                                req.listo ? 'line-through text-slate-400' : 'text-slate-900'
                              }`}
                            >
                              {req.texto}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Action Bar */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => void guardarOffline()}
                    className="min-h-[48px] px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                  >
                    {resultadoActual.id ? (
                      <>
                        <BookmarkCheck className="w-4 h-4 shrink-0" />
                        <span>Ya guardado</span>
                      </>
                    ) : (
                      <>
                        <BookmarkPlus className="w-4 h-4 shrink-0" />
                        <span>Guardar sin internet</span>
                      </>
                    )}
                  </button>

                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[48px] px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                  >
                    <Share2 className="w-4 h-4 shrink-0" />
                    <span>Enviar a familiar</span>
                  </a>

                  <button
                    type="button"
                    onClick={() => void copiarResumen()}
                    className="min-h-[48px] px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-900 font-semibold text-sm rounded-xl border border-slate-200 flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                  >
                    {copiado ? (
                      <>
                        <Check className="w-4 h-4 text-emerald-700 shrink-0" />
                        <span>Copiado</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4 shrink-0" />
                        <span>Copiar resumen</span>
                      </>
                    )}
                  </button>
                </div>
              </section>
            )}
          </div>

          {/* Right Column: Saved Folder */}
          <aside
            id="guardados"
            className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-4 lg:sticky lg:top-24"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-slate-950 flex items-center gap-2">
                  <FolderOpen className="w-5 h-5 text-blue-700 shrink-0" />
                  <span>Mis trámites guardados</span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  {modoOffline
                    ? 'Modo sin conexión · Leyendo copia local'
                    : 'Disponible con o sin internet en este dispositivo'}
                </p>
              </div>
              <span className="text-xs font-semibold text-slate-500 tabular-nums pt-1">
                {guardados.length} {guardados.length === 1 ? 'trámite' : 'trámites'}
              </span>
            </div>

            {/* Search Filter */}
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre o idioma..."
                aria-label="Buscar en trámites guardados"
                className="w-full min-h-[44px] pl-10 pr-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:bg-white"
              />
            </div>

            {/* List */}
            {cargandoGuardados ? (
              <div className="space-y-2.5">
                <div className="h-16 bg-slate-100 rounded-xl animate-pulse" />
                <div className="h-16 bg-slate-100 rounded-xl animate-pulse" />
              </div>
            ) : guardadosFiltrados.length === 0 ? (
              <div className="p-6 bg-slate-50 border border-slate-200 rounded-xl text-center space-y-1.5">
                <p className="font-semibold text-slate-800 text-sm">
                  {busqueda ? 'No hay trámites que coincidan con tu búsqueda' : 'Aún no tienes trámites guardados'}
                </p>
                <p className="text-xs text-slate-500">
                  Cuando expliques un documento, toca «Guardar sin internet» para tenerlo siempre a la mano.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-0.5">
                {guardadosFiltrados.map((item) => {
                  const activo = resultadoActual?.id === item.id;
                  const listos = (item.requisitos || []).filter((r) => r.listo).length;
                  const total = (item.requisitos || []).length;

                  return (
                    <div
                      key={item.id ?? item.titulo}
                      onClick={() => {
                        detenerVozAlta();
                        setResultadoActual(item);
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          detenerVozAlta();
                          setResultadoActual(item);
                        }
                      }}
                      className={`min-h-[64px] p-3.5 rounded-xl border cursor-pointer transition-colors flex items-center justify-between gap-3 ${
                        activo
                          ? 'bg-blue-50/70 border-blue-400'
                          : 'bg-slate-50 hover:bg-slate-100 border-slate-200'
                      }`}
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="font-bold text-slate-900 text-sm sm:text-base truncate">
                          {item.titulo}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 tabular-nums">
                          <span>Idioma: {item.idioma || 'Español'}</span>
                          {total > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>
                                {listos} de {total} requisitos
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => void eliminarGuardado(item.id, e)}
                          aria-label={`Eliminar ${item.titulo}`}
                          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>

        {/* How it works section */}
        <section id="como-funciona" className="pt-4 border-t border-slate-200">
          <h2 className="text-lg font-bold text-slate-900 mb-4">Cómo te ayuda Nexo</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-1.5">
              <p className="text-sm font-bold text-blue-800 tabular-nums">01. Pregunta o muestra tu papel</p>
              <p className="text-sm text-slate-600">
                Puedes escribir lo que te piden, dictar con el micrófono o tomar una foto clara de una carta o formulario.
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-1.5">
              <p className="text-sm font-bold text-blue-800 tabular-nums">02. Lee o escucha sin tecnicismos</p>
              <p className="text-sm text-slate-600">
                Te explicamos qué es, la fecha límite y los pasos concretos en Español, Náhuatl, Maya, English o Kreyòl.
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-1.5">
              <p className="text-sm font-bold text-blue-800 tabular-nums">03. Prepara tu carpeta y comparte</p>
              <p className="text-sm text-slate-600">
                Marca los papeles que ya tienes listos, guárdalos para verlos sin internet o envíalos por WhatsApp a un familiar.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white mt-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>Nexo · Orientación ciudadana en lectura fácil</span>
          <span>Verifica siempre fechas y requisitos finales en la oficina oficial correspondiente.</span>
        </div>
      </footer>
    </div>
  );
}
