export interface Requisito {
  texto: string;
  listo: boolean;
}

export interface Tramite {
  id?: string;
  titulo: string;
  idioma: string;
  que_es: string;
  fecha_limite: string;
  pasos?: string[];
  requisitos: Requisito[];
  texto_para_voz?: string;
  creado_en?: string;
}

export type IdiomaDestino =
  | 'Español'
  | 'Náhuatl'
  | 'Maya'
  | 'English'
  | 'Kreyòl Ayisyen';
