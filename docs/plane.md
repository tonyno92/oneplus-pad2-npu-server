# Piano & Documentazione Tecnica: OnePlus Pad 2 come Server OpenAI NPU-Only (Snapdragon 8 Gen 3)

## 0. Obiettivo Finale & Vincoli Architetturali

* **Obiettivo:** Trasformare il **OnePlus Pad 2** in un server locale in rete Wi-Fi (LAN) compatibile con le API **OpenAI (`POST /v1/chat/completions`)**, utilizzabile da assistenti di programmazione (**VS Code / Continue / Cursor / Cline**) o agenti IA generici.
* **Hardware Target:** SoC Qualcomm **Snapdragon 8 Gen 3 (`SM8650`)**, **16 GB RAM LPDDR5X**, NPU **Hexagon Tensor Processor (HTP) Architettura V75** (`soc_model: 57`).
* **Modello Scelto:** `Qwen3-4B-Instruct-2507` (Quantizzazione `W4A16`).
* **Vincolo Rigido — NPU-ONLY:** L'inferenza deve girare esclusivamente sulla **NPU Hexagon V75** tramite stack nativo Qualcomm (**QAIRT: QNN HTP + Genie SDK**). È vietata l'esecuzione su CPU/GPU via Termux o `llama.cpp` standard.
* **Ambiente Host di Build:** Container Distrobox (Ubuntu 24.04 x86_64) + Android NDK (per il Modulo 3).

---

## 1. Cambio di Paradigma: Perché la NPU non è `llama.cpp`

Chi proviene da `llama.cpp` (CPU/GPU) è abituato a un flusso dinamico: scarica un file `.gguf` ed esegue `llama-cli` che adatta i kernel di calcolo a qualsiasi lunghezza di input al volo (*runtime JIT/dinamico*).

Una **NPU mobile (Hexagon HTP)** segue un modello architetturale opposto:
1. **Non è una CPU né una GPU general-purpose:** è un acceleratore *dataflow* specializzato per algebra lineare quantizzata con una memoria SRAM interna minuscola (**VTCM**, pochi megabyte).
2. **Richiede compilazione Ahead-Of-Time (AOT):** non supporta tensori di dimensione variabile a runtime. Ogni operazione, dimensione di input e schema di *tiling* nella VTCM deve essere calcolato e congelato **prima** in binari specifici per quel chip (**Context Binary `.bin`**).

| Concetto | Mondo `llama.cpp` (CPU / GPU) | Mondo Qualcomm NPU (QAIRT / Genie) |
| :--- | :--- | :--- |
| **Formato Modello** | `.gguf` (pesi + metadati) | 4 file `.bin` (*Context Binaries*) + `tokenizer.json` |
| **Compilazione** | Kernel generici in `llama-cli` | Cross-compilazione AOT per singolo chip (`SM8650 / V75`) |
| **Runtime LLM** | `llama.cpp` | **Genie** (`libGenie.so`) sopra **QNN** (`libQnnHtp.so`) |
| **Server API** | `llama-server` | Demone C++ nativo (`cpp-httplib` + `libGenie.so`) |
| **Configurazione** | Flag CLI + header GGUF | `genie_config.json` + `htp_backend_ext_config.json` |
| **Analogia C/C++** | Interprete / JIT | Cross-compilazione `gcc -c -march=hexagon-v75` + linker `ld` |

---

## 2. Architettura Completa End-to-End (Dal Client LAN al Silicio)

```text
[ CLIENT IN LAN: PC / VS Code / Continue / Cursor / Agente IA ]
        |
        |  HTTP/1.1 JSON + SSE (Server-Sent Events)  [MODULO 3 - PROSSIMO]
        |  GET /v1/models  |  POST /v1/chat/completions (stream: true/false)
        v
+-------------------------------------------------------------------------+
| ONEPLUS PAD 2 - ARM64 Kryo CPU (Android User-Space / adb shell)         |
|                                                                         |
|  [ 1. Server HTTP & OpenAI Adapter (Demone C++ NDK) ]    [MODULO 3]     |
|      • Coda di inferenza single-slot (std::mutex)                       |
|      • ChatML Template (<|im_start|>...<|im_end|>) + Stop Sequences     |
|      • Traduzione parametri OpenAI (temp, top_p, max_tokens)            |
|        |  Chiamate C API (GenieDialog_create / query / reset)           |
|        v                                                                |
|  [ 2. libGenie.so (Generative AI Inference Engine) ]     [MODULO 2 OK]  |
|      • Tokenizer BPE (tokenizer.json), Sampler, gestione KV-Cache       |
|      • Switch automatico tra grafo Prefill (ar128) e Decode (ar1)       |
|        |  API QNN (esecuzione sequenziale dei 4 shard)                  |
|        v                                                                |
|  [ 3. QNN Runtime + HTP Stub ]                           [MODULO 2 OK]  |
|      • libQnnHtp.so + libQnnHtpNetRunExtensions.so (htp_backend_ext)    |
|      • Mappa i 4 .bin (3.02 GB) in RAM con mmap() (use-mmap: true)      |
|      • libQnnHtpV75Stub.so  <-- LD_LIBRARY_PATH punta qui               |
+--------|------------------------------------^---------------------------+
         |                                    |
         | FastRPC (/dev/fastrpc-cdsp)        | Shared RAM (DMA-BUF / mmap)
         | Invio comandi Zero-Copy            | I tensori restano in RAM
         v                                    |
+--------|------------------------------------v---------------------------+
| SOTTOSISTEMA HEXAGON cDSP (NPU V75 - Unsigned Protection Domain)        |
|                                                                         |
|  [ 4. libQnnHtpV75Skel.so ]  <-- ADSP_LIBRARY_PATH punta qui            |
|      • Decodifica gli schedule dei .bin e pilota il silicio             |
|      v                                                                  |
|  [ 5. VTCM (SRAM interna ultra-veloce) ]                                |
|      ├── HMX (Hexagon Matrix eXtensions) -> MatMul / Attention / Linear |
|      └── HVX (Hexagon Vector eXtensions) -> RMSNorm / RoPE / SiLU       |
+-------------------------------------------------------------------------+
```

---

## 3. Glossario Tecnico Ragionato (Acronimi & Componenti)

### Hardware & Memoria
* **SoC (System on Chip):** L'intero chip `SM8650` (Snapdragon 8 Gen 3) che integra CPU, GPU e cDSP.
* **UMA (Unified Memory Architecture):** Architettura in cui CPU e NPU accedono alla stessa RAM LPDDR5X fisica senza una VRAM separata.
* **cDSP (Compute Digital Signal Processor):** Il processore dedicato al calcolo parallelo dentro il SoC, basato su architettura **Hexagon V75**.
* **HTP (Hexagon Tensor Processor):** Il motore neurale vero e proprio ("la NPU") dentro il cDSP.
* **HMX / HVX:** Unità di esecuzione dell'HTP rispettivamente per operazioni **matriciali** (pesanti) e **vettoriali** (normalizzazioni, attivazioni).
* **VTCM (Vector Tightly Coupled Memory):** Piccola SRAM interna al silicio HTP usata per il *tiling* ad altissima banda senza colpire continuamente la RAM esterna.
* **DCVS (Dynamic Clock and Voltage Scaling):** Governatore energetico del SoC che regola frequenze e voltaggi di NPU e bus RAM.

### Ponte Android ↔ cDSP & Permessi
* **FastRPC (`/dev/fastrpc-cdsp`):** Meccanismo kernel Android per invocazioni remote tra CPU ARM64 e cDSP passando puntatori di memoria condivisa (*DMA-BUF zero-copy*).
* **Stub & Skel:** La coppia proxy di FastRPC. Lo **Stub** (`libQnnHtpV75Stub.so`) gira su CPU e serializza le chiamate; lo **Skel** (`libQnnHtpV75Skel.so`) gira dentro il cDSP e guida l'hardware.
* **Unsigned PD (Unsigned Protection Domain):** Sandbox isolata dentro il cDSP che permette l'esecuzione di codice compute (`Skel`) senza firme crittografiche proprietarie di produzione OEM.
* **`LD_LIBRARY_PATH`:** Variabile d'ambiente Linux/Android che indica dove cercare le librerie ARM64 (`.so` per la CPU).
* **`ADSP_LIBRARY_PATH`:** Variabile letta dal daemon `adsprpc` per trovare lo **`Skel`** (`libQnnHtpV75Skel.so`) da iniettare nel cDSP.

### Stack Software & Modello
* **QAIRT (Qualcomm AI Runtime):** L'SDK completo di Qualcomm che unifica QNN e Genie.
* **QNN (Qualcomm AI Engine Direct):** Runtime di basso livello (analogo a CUDA/Vulkan) per eseguire grafi compilati su `QnnCpu`, `QnnGpu` o **`QnnHtp`** (NPU).
* **Genie (Generative AI Inference Engine):** Motore LLM sopra QNN (analogo a `llama.cpp`): gestisce tokenizer, loop autoregressivo, stitching degli shard e sampling.
* **AIMET:** Toolkit Qualcomm usato per calibrare e quantizzare i pesi prima della compilazione.
* **`W4A16`:** Pesi quantizzati a **4 bit interi (`INT4`)**, attivazioni a **16 bit (`FP16`/`INT16`)**. Riduce di 4× la banda richiesta dalla LPDDR5X mantenendo alta la qualità su codice e JSON.
* **RoPE (Rotary Position Embedding):** Codifica matematica delle posizioni dei token nell'Attention.
* **TTFT (Time To First Token):** Latenza dall'invio del prompt alla generazione del primo token di risposta.
* **SSE (Server-Sent Events):** Protocollo HTTP (`Content-Type: text/event-stream`) usato dalle API OpenAI per inviare i token uno alla volta in tempo reale al client.

---

## 4. Modulo 1 `[COMPLETATO]` — Scelta, Compilazione e Linking del Modello

### 4.1 Scelta del Modello e Dimensionamento
Su Snapdragon 8 Gen 3 (banda LPDDR5X ~68 GB/s), la fase di generazione (*decode*) è **memory-bandwidth-bound**: i `tok/s` dipendono dai gigabyte di pesi letti per ogni token.
* **`Qwen3-4B-Instruct-2507` (`DEFAULT_W4A16`)**: ~3.02 GB totali. Offre il miglior equilibrio tra qualità su codice/agenti (senza blocchi `<think>` superflui) e velocità reale (~18.3 tok/s misurati), ed è **già pre-quantizzato da Qualcomm** (non richiede una GPU NVIDIA da 40–80 GB VRAM per la calibrazione AIMET locale).

### 4.2 Fix Ambiente Distrobox (Ubuntu 24.04)
Nei container Distrobox su host con `/tmp` montato in RAM (`tmpfs`), il tracing ONNX e la cache Hugging Face saturano `/tmp` provocando falsi errori `No space left on device` o uccisione OOM anche con disco libero.

```bash
df -hT   # Verifica di puntare a un filesystem reale (ext4/btrfs/xfs), NON tmpfs

export WORK_DIR="$HOME/qai_work"
mkdir -p "$WORK_DIR"/{tmp,hf_cache,xdg_cache}

export TMPDIR="$WORK_DIR/tmp"
export TEMP="$WORK_DIR/tmp"
export TMP="$WORK_DIR/tmp"
export HF_HOME="$WORK_DIR/hf_cache"
export HUGGINGFACE_HUB_CACHE="$WORK_DIR/hf_cache/hub"
export XDG_CACHE_HOME="$WORK_DIR/xdg_cache"
export TORCH_HOME="$WORK_DIR/xdg_cache/torch"
```
*(Esecuzione dentro `tmux` per non interrompere il processo client mentre i job girano sul cloud).*

### 4.3 Anatomia dei file intermedi (`.qaihm/.../v5/qwen3_4b_instruct_2507_w4a16/`)
* `model_dynamic.onnx` + `model.data`: grafo computazionale ONNX + file esterno dei pesi (necessario per il limite di 2 GB del protobuf ONNX).
* `model.encodings`: parametri matematici AIMET (`scale`, `offset`, bitwidth) per convertire ogni tensore in `W4A16`.
* `tokenizer.json`, `vocab.json`, `merges.txt`, `config.json`: vocabolario BPE, token speciali (`<|im_start|>`, `<|im_end|>`) e metadati architetturali.
* `eval_float.log` / `eval_quantized.log`: report di verifica accuratezza pre/post quantizzazione.

### 4.4 Pipeline di Build: 4 Shard × 10 Grafi (`CompileJob` → `LinkJob`)

```text
[ Sorgente: ONNX + model.data + model.encodings (36 Layer Transformer) ]
        |
        +---> Taglio orizzontale in 4 SHARD (part1_of_4 ... part4_of_4)
        |     Motivo: limiti di allocazione/mappatura FastRPC sul cDSP
        |             + compilazione cloud parallela.
        |
        +---> Per OGNI shard, "srotolamento" in 10 shape statiche (CompileJob):
              ├── Prefill: prompt_ar128_cl{512, 1024, 2048, 3072, 4096}
              └── Decode:  token_ar1_cl{512, 1024, 2048, 3072, 4096}
                    (4 shard x 10 varianti = 40 CompileJob)
        |
        v
[ FASE A: 40 CompileJob Cloud (Target: "Samsung Galaxy S24 (Family)" == SM8650 V75) ]
  • Traduce ONNX + encodings in istruzioni Hexagon HTP W4A16
  • Esegue operator fusion e tiling VTCM
        |
        v
[ FASE B: 4 LinkJob Cloud (1 per shard, via hub.submit_link_job) ]
  • Fonde i 10 DLC dello stesso shard in UN solo Context Binary (.bin)
  • Weight Sharing: i pesi W4A16 vengono salvati UNA sola volta e condivisi
    tra tutti i 10 grafi dello shard (evita di moltiplicare la RAM x10!)
  • Buffer Sharing: condivide la memoria scratchpad tra grafi non simultanei
        |
        v
[ OUTPUT FINALE MODULO 1: ./genie_bundle_qwen3/ ]
  ├── qwen3_4b_instruct_2507_part1_of_4.bin  ( 743 MB ) -> Embedding + primi layer
  ├── qwen3_4b_instruct_2507_part2_of_4.bin  ( 632 MB ) -> Layer intermedi
  ├── qwen3_4b_instruct_2507_part3_of_4.bin  ( 632 MB ) -> Layer intermedi
  ├── qwen3_4b_instruct_2507_part4_of_4.bin  (1011 MB ) -> Ultimi layer + LM Head (151.936 token)
  └── tokenizer.json                         (  ~11 MB )
```

**Perché questi dettagli tecnici:**
* **`ar128` + `ar1`:** `ar128` processa 128 token alla volta per saturare le unità HMX in Prefill; `ar1` genera 1 token per volta in Decode.
* **5 bucket `cl512..cl4096`:** Evita di sprecare banda LPDDR5X leggendo/mascherando una KV-Cache da 4096 slot su prompt brevi; Genie seleziona il bucket minimo e scala verso l'alto solo quando la conversazione cresce.
* **Target `"Samsung Galaxy S24 (Family)"`:** Condivide esattamente lo stesso silicio `SM8650 / Hexagon V75` (`soc_model: 57`) del OnePlus Pad 2.

---

## 5. Modulo 2 `[COMPLETATO]` — Runtime Nativo Android, Validazione Hardware & Benchmark

### Step 2.1 `[COMPLETATO]` — Allineamento QAIRT SDK (Host Linux)
Verifica della versione esatta dai `LinkJob` e download del **QAIRT SDK** allineato (`>= 2.45.0`) con ispezione dei `.bin` tramite `qnn-context-binary-utility`.

### Step 2.2 `[COMPLETATO]` — Configurazioni Hardware & Genie

#### 1. `htp_backend_ext_config.json` (Tuning Silicio HTP/cDSP)
```json
{
    "devices": [
        {
            "soc_model": 57,
            "dsp_arch": "v75",
            "cores": [
                {
                    "core_id": 0,
                    "perf_profile": "burst",
                    "rpc_control_latency": 100
                }
            ]
        }
    ]
}
```
* **`soc_model: 57` + `dsp_arch: "v75"`:** Identifica lo Snapdragon 8 Gen 3 (`SM8650`).
* **`perf_profile: "burst"`:** Disabilita il risparmio energetico **DCVS** e spinge clock NPU e bus LPDDR5X al massimo.
* **`rpc_control_latency: 100`:** Limita a 100 µs la latenza di risveglio FastRPC CPU ↔ cDSP.

#### 2. `genie_config.json` (Orchestrazione LLM `libGenie.so`)
```json
{
    "dialog": {
        "version": 1,
        "type": "basic",
        "context": {
            "version": 1,
            "size": 4096,
            "n-vocab": 151936,
            "bos-token": 151643,
            "eos-token": 151645
        },
        "sampler": {
            "version": 1,
            "seed": -1,
            "temp": 0.7,
            "top-k": 40,
            "top-p": 0.9
        },
        "tokenizer": {
            "version": 1,
            "path": "tokenizer.json"
        },
        "engine": {
            "version": 1,
            "n-threads": 3,
            "backend": {
                "version": 1,
                "type": "QnnHtp",
                "QnnHtp": {
                    "version": 1,
                    "use-mmap": true,
                    "spill-fill-bufsize": 0,
                    "mmap-budget": 0,
                    "poll": true,
                    "cpu-mask": "0xe0",
                    "kv-dim": 128,
                    "allow-async-init": false,
                    "pos-id-dim": 64,
                    "rope-theta": 5000000
                },
                "extensions": "htp_backend_ext_config.json"
            },
            "model": {
                "version": 1,
                "type": "binary",
                "binary": {
                    "version": 1,
                    "ctx-bins": [
                        "qwen3_4b_instruct_2507_part1_of_4.bin",
                        "qwen3_4b_instruct_2507_part2_of_4.bin",
                        "qwen3_4b_instruct_2507_part3_of_4.bin",
                        "qwen3_4b_instruct_2507_part4_of_4.bin"
                    ]
                }
            }
        }
    }
}
```
* **`type: "QnnHtp"`:** Vincolo **NPU-ONLY** (nessun fallback CPU).
* **`use-mmap: true`:** Mappa i 3.02 GB di `.bin` evitando copie duplicate in RAM.
* **`poll: true` + `cpu-mask: "0xe0"` + `n-threads: 3`:** Polling attivo sui 3 core ARM64 veloci (CPU 5, 6, 7) per azzerare le latenze tra i 4 shard per ogni token.
* **`kv-dim: 128`, `pos-id-dim: 64`, `rope-theta: 5000000`:** Coordinate matematiche Attention/RoPE di `Qwen3-4B`.

### Step 2.3 `[COMPLETATO]` — Deploy su Tablet & Validazione Hardware cDSP
Deploy su `/data/local/tmp/npu_llm/` (contesto `adb shell` per evitare blocchi SELinux di `untrusted_app`) di:
* Librerie ARM64 (`libGenie.so`, `libQnnHtp.so`, `libQnnSystem.so`, `libQnnHtpNetRunExtensions.so`, `libQnnHtpV75Stub.so`, `libQnnHtpV75CalculatorStub.so`)
* Librerie Hexagon V75 (`libQnnHtpV75Skel.so`, `libCalculator_skel.so`)
* Eseguibili (`qnn-platform-validator`, `genie-t2t-run`) e bundle modello (`.bin`, `tokenizer.json`, JSON config).

### Step 2.4 `[COMPLETATO]` — Esecuzione NPU-Only & Benchmark Reali (`profile.json`)
Comando eseguito con formato ChatML nativo Qwen3 (`--profile profile.json`):
```bash
LD_LIBRARY_PATH=/data/local/tmp/npu_llm \
ADSP_LIBRARY_PATH=/data/local/tmp/npu_llm \
./genie-t2t-run -c genie_config.json \
  -p "<|im_start|>user\n...<|im_end|>\n<|im_start|>assistant\n" \
  --profile profile.json
```

**Metriche reali misurate su OnePlus Pad 2 (`SM8650 / Hexagon V75`):**

| Metrica (`profile.json`) | Valore Misurato | Significato Architetturale |
| :--- | :--- | :--- |
| **`GenieDialog_create` (`init-time`)** | **5.20 s** (`5,200,294 µs`) | Caricamento + `mmap` dei 4 shard (3.02 GB) e apertura sessione FastRPC cDSP. |
| **`prompt-processing-rate` (Prefill)** | **356.51 tok/s** (27 tok) | Elaborazione parallela sulle unità matriciali **HMX** (`prompt_ar128`). |
| **`time-to-first-token` (TTFT)** | **75.75 ms** (`75,752 µs`) | Latenza quasi istantanea prima di emettere il primo token di risposta. |
| **`token-generation-rate` (Decode)** | **18.27 tok/s** (90 tok in 4.87 s) | Switch automatico su `token_ar1` confermato; banda effettiva sostenuta ~40 GB/s su LPDDR5X (~60% del picco teorico). |
| **`GenieDialog_free`** | **0.31 s** (`314,202 µs`) | Rilascio pulito della memoria condivisa DMA-BUF e chiusura del Protection Domain cDSP. |

*Nota progettuale critica:* I `5.20 s` di `init-time` contro i `4.96 s` di `query` dimostrano matematicamente che il server del Modulo 3 deve eseguire `GenieDialog_create` **una sola volta all'avvio** mantenendo il dialog residente in RAM.

---

## 6. Modulo 3 `[PROSSIMO STEP — DA ESEGUIRE]` — Server HTTP Compatibile OpenAI in LAN

### 6.1 Scelta Tecnologica del Server
Cross-compilazione con **Android NDK (`aarch64-linux-android28-clang++`)** di un **demone C++ nativo (`npu-openai-server`)** linkato direttamente a `libGenie.so` usando librerie header-only:
* **`cpp-httplib`**: server HTTP/1.1 multi-thread con supporto chunked per streaming SSE;
* **`nlohmann/json`**: parsing/serializzazione JSON OpenAI.

### 6.2 Endpoint API da Implementare
1. **`GET /v1/models`**:
   Restituisce lo schema JSON OpenAI con l'ID modello (es. `qwen3-4b-instruct-2507-npu`) per il rilevamento automatico da parte degli IDE/agenti.
2. **`POST /v1/chat/completions`**:
   * **`stream: true`**: emette chunk progressivi token-by-token (`Content-Type: text/event-stream`, eventi `data: {"choices":[{"delta":{"content":"..."}}]}` chiusi da `data: [DONE]\n\n`).
   * **`stream: false`**: restituisce l'oggetto JSON completo a fine generazione con conteggio token `usage`.

### 6.3 Logica Interna Critica (`C++` ↔ `libGenie.so`)
1. **Modello Residente in Memoria (`GenieDialog_create` una tantum):**
   Elimina i 5.20 s di cold-start sulle chiamate API successive (TTFT costante sotto ~100 ms per prompt brevi).
2. **Coda di Inferenza Single-Slot (`std::mutex`):**
   La NPU V75 esegue un contesto attivo alla volta; il mutex serializza eventuali chiamate parallele provenienti dall'IDE evitando corruzione dello stato cDSP.
3. **Stateless OpenAI → ChatML + Reset KV-Cache (`GenieDialog_reset`):**
   Converte l'array `messages` (`system`, `user`, `assistant`, `tool`) nel template Qwen3 (`<|im_start|>role\n...<|im_end|>`) e resetta la KV-Cache tra turni/richieste indipendenti.
4. **Mapping Dinamico Parametri OpenAI → Genie Sampler:**
   Applica per ogni richiesta `temperature`, `top_p`, `max_tokens` tramite le API C di Genie (`GenieDialog_getSampler`, `GenieSamplerConfig_createFromJson`, `GenieSamplerConfig_setParam`, `GenieSampler_applyConfig`, `GenieDialog_setMaxNumTokens`).
5. **Streaming Callback & Stop Sequences (`<|im_end|>`, `stop`):**
   La callback di `GenieDialog_query` invia ogni token generato sullo stream HTTP e interrompe pulitamente la generazione con `GENIE_DIALOG_SENTENCE_ABORT` appena incontra una stop sequence.

### 6.4 Deployment in LAN, Stabilità Android & Integrazione Client
* **Avvio Persistente su Tablet:** Ascolto su `0.0.0.0:8080` dentro `/data/local/tmp/npu_llm/` (con `LD_LIBRARY_PATH` e `ADSP_LIBRARY_PATH` configurati, più `WakeLock` / prevenzione sleep Wi-Fi per sessioni a schermo spento).
* **Configurazione Client (VS Code / Continue / Cursor / OpenAI SDK):**
  * **Base URL:** `http://<IP_LOCALE_ONEPLUS_PAD_2>:8080/v1`
  * **Model ID:** `qwen3-4b-instruct-2507-npu`
  * **API Key:** qualsiasi stringa fittizia (es. `npu-local`)

---

## 7. Checklist di Avanzamento Complessiva

* [x] **Modulo 0:** Scelta architettura (QAIRT + Genie, Demone C++ nativo) e analisi hardware `SM8650 / V75`.
* [x] **Modulo 1.1–1.2:** Scelta `Qwen3-4B-Instruct-2507` (`W4A16`), fix `tmpfs` Distrobox.
* [x] **Modulo 1.3–1.4:** Compilazione cloud (40 `CompileJob`) + Linking (4 `LinkJob`) + Download 4 `.bin` (3.02 GB) e `tokenizer.json`.
* [x] **Modulo 2 — Step 2.1:** Verifica versione QAIRT + setup SDK su PC.
* [x] **Modulo 2 — Step 2.2:** Creazione `htp_backend_ext_config.json` e `genie_config.json`.
* [x] **Modulo 2 — Step 2.3:** Push runtime + librerie V75 su tablet e validazione hardware cDSP.
* [x] **Modulo 2 — Step 2.4:** Esecuzione NPU-only con `genie-t2t-run` e validazione `profile.json` (**356.5 tok/s prefill**, **18.27 tok/s decode**, **75.7 ms TTFT**).
* [ ] **Modulo 3 — Step 3.1:** Setup Android NDK e cross-compilazione del demone `npu-openai-server`.
* [ ] **Modulo 3 — Step 3.2:** Implementazione `GET /v1/models` e `POST /v1/chat/completions` (SSE streaming + ChatML + sampler dinamico + `std::mutex`).
* [ ] **Modulo 3 — Step 3.3:** Avvio persistente su OnePlus Pad 2 e test end-to-end in LAN da **VS Code / Continue / Cursor**.


mjmohnpp3bi0xtwvzs0ikk6v08hr1bwzlj9oroqt
