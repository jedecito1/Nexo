import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

interface RequisitoInput {
  texto: string;
  listo: boolean;
}

interface TramiteRecord {
  id: string;
  titulo: string;
  idioma: string;
  que_es: string;
  fecha_limite: string;
  pasos: string[];
  requisitos: RequisitoInput[];
  texto_para_voz: string;
  creado_en?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, 'data');
const DB_PATH = path.resolve(DATA_DIR, 'tramites.json');
if (!DB_PATH.startsWith(DATA_DIR + path.sep)) {
  throw new Error('Invalid database path');
}

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

const ALLOWED_LANGUAGES = new Set([
  'Español',
  'Náhuatl',
  'Maya',
  'English',
  'Kreyòl Ayisyen',
]);

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

function ensureDbFile(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2), 'utf-8');
  }
}

function readTramites(): TramiteRecord[] {
  ensureDbFile();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeTramites(items: TramiteRecord[]): void {
  ensureDbFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(items, null, 2), 'utf-8');
}

function sanitizeRequisitos(input: unknown): RequisitoInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 30)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      texto: typeof item.texto === 'string' ? item.texto.trim().slice(0, 400) : '',
      listo: Boolean(item.listo),
    }))
    .filter((item) => item.texto.length > 0);
}

function sanitizePasos(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 15)
    .filter((step): step is string => typeof step === 'string')
    .map((step) => step.trim().slice(0, 500))
    .filter((step) => step.length > 0);
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '25mb' }));

ensureDbFile();

app.post('/api/traducir', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      return res.status(500).json({
        error: 'No se encontró una clave válida de Gemini en Settings > Secrets.',
      });
    }

    const body = req.body ?? {};
    const texto = typeof body.texto === 'string' ? body.texto.trim() : '';
    const imagenBase64 = typeof body.imagenBase64 === 'string' ? body.imagenBase64.trim() : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : '';
    const rawLang = typeof body.idiomaDestino === 'string' ? body.idiomaDestino.trim() : 'Español';
    const idiomaDestino = ALLOWED_LANGUAGES.has(rawLang) ? rawLang : 'Español';

    if (!texto && !imagenBase64) {
      return res.status(400).json({
        error: 'Escribe un texto, usa tu voz o selecciona una foto del documento.',
      });
    }

    if (texto.length > 15000) {
      return res.status(400).json({
        error: 'El texto es demasiado largo. Intenta resumirlo o dividirlo en partes más cortas.',
      });
    }

    if (imagenBase64) {
      if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        return res.status(400).json({
          error: 'Formato de imagen no compatible. Usa JPG, PNG o WEBP.',
        });
      }
      if (imagenBase64.length > 10_000_000) {
        return res.status(400).json({
          error: 'La imagen es demasiado pesada. Toma una foto más ligera.',
        });
      }
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const systemInstruction = `Eres Nexo, un orientador amable y paciente para adultos mayores, personas migrantes, comunidades indígenas y estudiantes.
Explica trámites y documentos oficiales con oraciones cortas, palabras sencillas de uso diario y cero tecnicismos legales o burocráticos.
Responde únicamente en el idioma solicitado: ${idiomaDestino}.
No inventes fechas, montos ni requisitos que no estén en el texto o en la imagen; si un dato no aparece, indícalo con claridad.
En "pasos", da entre 2 y 5 pasos claros y breves de qué hacer primero, después y al final.
En "texto_para_voz", redacta un resumen cálido, natural y fácil de escuchar en voz alta en ${idiomaDestino}.`;

    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];

    if (imagenBase64 && mimeType) {
      parts.push({
        inlineData: {
          data: imagenBase64,
          mimeType,
        },
      });
    }

    parts.push({
      text: texto
        ? `Consulta o texto del documento del usuario:\n${texto}`
        : 'Analiza la imagen de este documento oficial y explícalo en palabras simples.',
    });

    let response;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                titulo: {
                  type: Type.STRING,
                  description: 'Nombre corto y claro del trámite o documento.',
                },
                que_es: {
                  type: Type.STRING,
                  description: 'Explicación sencilla de qué es y para qué sirve.',
                },
                fecha_limite: {
                  type: Type.STRING,
                  description: 'Fecha límite indicada o "Sin fecha límite especificada".',
                },
                pasos: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Pasos breves y ordenados para realizar o atender el trámite.',
                },
                requisitos: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      texto: {
                        type: Type.STRING,
                        description: 'Requisito explicado en palabras simples.',
                      },
                      listo: {
                        type: Type.BOOLEAN,
                        description: 'Siempre inicia en false.',
                      },
                    },
                    required: ['texto', 'listo'],
                  },
                },
                texto_para_voz: {
                  type: Type.STRING,
                  description: 'Resumen amable pensado para ser leído en voz alta.',
                },
              },
              required: ['titulo', 'que_es', 'fecha_limite', 'pasos', 'requisitos', 'texto_para_voz'],
            },
          },
        });
        break;
      } catch (err: unknown) {
        lastError = err;
        const status = (err as { status?: number })?.status;
        if ((status !== 503 && status !== 429) || attempt === 2) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }

    if (!response || !response.text) {
      throw lastError ?? new Error('No se recibió respuesta del modelo.');
    }

    const parsed = JSON.parse(response.text);
    return res.json({
      titulo: typeof parsed.titulo === 'string' ? parsed.titulo : 'Trámite consultado',
      que_es: typeof parsed.que_es === 'string' ? parsed.que_es : '',
      fecha_limite: typeof parsed.fecha_limite === 'string' ? parsed.fecha_limite : 'Sin fecha límite especificada',
      pasos: sanitizePasos(parsed.pasos),
      requisitos: sanitizeRequisitos(parsed.requisitos),
      texto_para_voz: typeof parsed.texto_para_voz === 'string' ? parsed.texto_para_voz : '',
    });
  } catch (err: unknown) {
    console.error('Error en /api/traducir:', err);
    const status = (err as { status?: number })?.status;
    if (status === 403 || status === 400) {
      return res.status(status).json({
        error: 'Verifica tu clave de Gemini en Settings > Secrets e intenta de nuevo.',
      });
    }
    if (status === 429) {
      return res.status(429).json({
        error: 'Se alcanzó el límite temporal de consultas. Espera unos segundos e intenta otra vez.',
      });
    }
    if (status === 503) {
      return res.status(503).json({
        error: 'El servicio está ocupado en este momento. Intenta nuevamente en unos segundos.',
      });
    }
    return res.status(500).json({
      error: 'No se pudo explicar el documento en este momento. Intenta de nuevo.',
    });
  }
});

app.get('/api/tramites', (_req: Request, res: Response) => {
  try {
    const items = readTramites();
    return res.json(items);
  } catch (err) {
    console.error('Error al leer trámites:', err);
    return res.status(500).json({ error: 'No se pudieron cargar los trámites guardados.' });
  }
});

app.post('/api/tramites', (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const titulo = typeof body.titulo === 'string' ? body.titulo.trim().slice(0, 200) : '';
    const que_es = typeof body.que_es === 'string' ? body.que_es.trim().slice(0, 2000) : '';

    if (!titulo || !que_es) {
      return res.status(400).json({ error: 'Faltan datos del trámite para guardarlo.' });
    }

    const items = readTramites();
    const nuevoTramite: TramiteRecord = {
      id: `tramite-${Date.now()}`,
      titulo,
      idioma: typeof body.idioma === 'string' && ALLOWED_LANGUAGES.has(body.idioma) ? body.idioma : 'Español',
      que_es,
      fecha_limite:
        typeof body.fecha_limite === 'string' && body.fecha_limite.trim()
          ? body.fecha_limite.trim().slice(0, 200)
          : 'Sin fecha límite especificada',
      pasos: sanitizePasos(body.pasos),
      requisitos: sanitizeRequisitos(body.requisitos),
      texto_para_voz:
        typeof body.texto_para_voz === 'string' ? body.texto_para_voz.trim().slice(0, 3000) : '',
      creado_en: new Date().toISOString(),
    };

    items.unshift(nuevoTramite);
    writeTramites(items);

    return res.status(201).json({
      mensaje: 'Guardado correctamente',
      tramite: nuevoTramite,
    });
  } catch (err) {
    console.error('Error al guardar trámite:', err);
    return res.status(500).json({ error: 'No se pudo guardar el trámite.' });
  }
});

app.put('/api/tramites/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id ?? '');
    if (!ID_PATTERN.test(id)) {
      return res.status(400).json({ error: 'Identificador inválido.' });
    }

    const items = readTramites();
    const index = items.findIndex((t) => t.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Trámite no encontrado.' });
    }

    const body = req.body ?? {};
    const existing = items[index];
    const updated: TramiteRecord = {
      ...existing,
      requisitos: Array.isArray(body.requisitos) ? sanitizeRequisitos(body.requisitos) : existing.requisitos,
      titulo: typeof body.titulo === 'string' && body.titulo.trim() ? body.titulo.trim().slice(0, 200) : existing.titulo,
      que_es: typeof body.que_es === 'string' && body.que_es.trim() ? body.que_es.trim().slice(0, 2000) : existing.que_es,
      fecha_limite:
        typeof body.fecha_limite === 'string' && body.fecha_limite.trim()
          ? body.fecha_limite.trim().slice(0, 200)
          : existing.fecha_limite,
    };

    items[index] = updated;
    writeTramites(items);
    return res.json(updated);
  } catch (err) {
    console.error('Error al actualizar trámite:', err);
    return res.status(500).json({ error: 'No se pudo actualizar el trámite.' });
  }
});

app.delete('/api/tramites/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id ?? '');
    if (!ID_PATTERN.test(id)) {
      return res.status(400).json({ error: 'Identificador inválido.' });
    }

    const items = readTramites();
    const nextItems = items.filter((t) => t.id !== id);
    if (nextItems.length === items.length) {
      return res.status(404).json({ error: 'Trámite no encontrado.' });
    }

    writeTramites(nextItems);
    return res.json({ eliminado: true, id });
  } catch (err) {
    console.error('Error al eliminar trámite:', err);
    return res.status(500).json({ error: 'No se pudo eliminar el trámite.' });
  }
});

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta de API no encontrada.' });
});

app.use((err: unknown, req: Request, res: Response, next: express.NextFunction) => {
  if (req.path.startsWith('/api')) {
    const status = (err as { status?: number; type?: string })?.status || 500;
    const type = (err as { type?: string })?.type;
    if (type === 'entity.too.large' || status === 413) {
      return res.status(413).json({
        error: 'La imagen o el texto enviado es demasiado pesado. Intenta con una foto más pequeña.',
      });
    }
    if (err instanceof SyntaxError && status === 400) {
      return res.status(400).json({
        error: 'Los datos enviados no tienen un formato válido.',
      });
    }
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: 'Ocurrió un error en el servidor. Intenta nuevamente.',
    });
  }
  return next(err);
});

async function startServer(): Promise<void> {
  const isDev = process.argv.includes('--dev');

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor Nexo corriendo en http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Error al iniciar el servidor Nexo:', err);
  process.exit(1);
});
