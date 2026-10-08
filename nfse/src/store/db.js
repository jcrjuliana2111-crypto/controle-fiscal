import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Persistência simples em arquivo JSON com escrita atômica. Suficiente para um
// escritório; para muitos usuários simultâneos troque por Postgres/Supabase
// mantendo a mesma interface (get/update).

const VAZIO = { prestadores: [], notas: [], municipios: {} };

class JsonDb {
  constructor(arquivo) {
    this.arquivo = arquivo;
    this.dados = null;
  }
  get() {
    if (!this.dados) {
      fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
      this.dados = fs.existsSync(this.arquivo)
        ? { ...structuredClone(VAZIO), ...JSON.parse(fs.readFileSync(this.arquivo, 'utf8')) }
        : structuredClone(VAZIO);
    }
    return this.dados;
  }
  update(fn) {
    const d = this.get();
    const r = fn(d);
    const tmp = this.arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, this.arquivo);
    return r;
  }
  reset(arquivo) {
    this.arquivo = arquivo;
    this.dados = null;
  }
}

export const db = new JsonDb(path.join(config.dataDir, 'db.json'));
