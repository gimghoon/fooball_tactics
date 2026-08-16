import { computeEvidenceVersion, parseBundleInput, parseVideoClip, type EvidenceBundleInput, type VideoClipInput } from "../domain/evidence.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import type { EvidenceFileStore, StoredEvidenceFile } from "./evidence-storage.ts";

export type EvidenceAnalysisSettings={analyzerModel:string;promptVersion:string;schemaVersion:string};
export type EvidenceBundleRecord=EvidenceBundleInput&{id:string;version:number;contentVersion:string;createdAt:number;updatedAt:number};
export type EvidenceVideoClipRecord=VideoClipInput&{id:string;bundleId:string;createdAt:number;updatedAt:number};
export type EvidenceAuditEventInput={id:string;bundleId:string;actorUserId:string;action:string;targetType:string;targetId:string;detailsJson:string;createdAt:number};
export type EvidenceDeleteImpact={sourceId:string;cardIds:string[];scenarioDraftIds:string[]};
export type EvidenceBundleDetail=EvidenceBundleRecord&{sources:StoredEvidenceFile[];videoClips:EvidenceVideoClipRecord[]};
export type EvidenceBundleUpdate=Partial<EvidenceBundleInput>;
export class EvidenceConflictError extends Error { readonly status=409; constructor(){super("근거 묶음이 다른 변경으로 갱신되었습니다. 다시 시도해 주세요.");} }
export type EvidenceMutation={current:EvidenceBundleRecord;next:EvidenceBundleRecord;audit:EvidenceAuditEventInput;sourceToInsert?:StoredEvidenceFile;sourceToDelete?:string;clipToInsert?:EvidenceVideoClipRecord};
export type EvidenceD1Statement={bind(...values:unknown[]):EvidenceD1Statement;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>;run():Promise<{meta?:{changes?:number}}>};
export type EvidenceD1Database={prepare(query:string):EvidenceD1Statement;batch(statements:EvidenceD1Statement[]):Promise<{meta?:{changes?:number}}[]>};
export type EvidenceServiceRepository={getBundle(id:string):Promise<EvidenceBundleRecord|null>;listBundles():Promise<EvidenceBundleRecord[]>;listSources(bundleId:string):Promise<StoredEvidenceFile[]>;findSource(sourceId:string):Promise<StoredEvidenceFile|null>;listVideoClips(bundleId:string):Promise<EvidenceVideoClipRecord[]>;findSourceByHash(bundleId:string,hash:string):Promise<StoredEvidenceFile|null>;describeDeleteImpact(sourceId:string):Promise<EvidenceDeleteImpact>;createBundle(bundle:EvidenceBundleRecord,audit:EvidenceAuditEventInput):Promise<void>;applyMutation(mutation:EvidenceMutation):Promise<boolean>};
const guard="EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)";
/** Production D1 adapter: every dependent write shares an optimistic-CAS guard in one atomic batch. */
export class D1EvidenceServiceRepository implements EvidenceServiceRepository {
  constructor(private readonly db:EvidenceD1Database){}
  async getBundle(id:string){return this.db.prepare("SELECT id,title,purpose,version,content_version AS contentVersion,created_at AS createdAt,updated_at AS updatedAt FROM evidence_bundles WHERE id=?").bind(id).first<EvidenceBundleRecord>()}
  async listBundles(){return (await this.db.prepare("SELECT id,title,purpose,version,content_version AS contentVersion,created_at AS createdAt,updated_at AS updatedAt FROM evidence_bundles ORDER BY updated_at DESC").all<EvidenceBundleRecord>()).results}
  async listSources(bundleId:string){return (await this.db.prepare("SELECT id,bundle_id AS bundleId,original_file_name AS originalFileName,media_type AS mediaType,byte_size AS byteSize,content_hash AS contentHash,storage_key AS storageKey,extracted_text_key AS extractedTextKey,extraction_status AS extractionStatus,extraction_error AS extractionError FROM evidence_sources WHERE bundle_id=?").bind(bundleId).all<StoredEvidenceFile>()).results}
  async findSource(id:string){return this.db.prepare("SELECT id,bundle_id AS bundleId,original_file_name AS originalFileName,media_type AS mediaType,byte_size AS byteSize,content_hash AS contentHash,storage_key AS storageKey,extracted_text_key AS extractedTextKey,extraction_status AS extractionStatus,extraction_error AS extractionError FROM evidence_sources WHERE id=?").bind(id).first<StoredEvidenceFile>()}
  async listVideoClips(bundleId:string){return (await this.db.prepare("SELECT id,bundle_id AS bundleId,url,start_ms AS startMs,end_ms AS endMs,observation,created_at AS createdAt,updated_at AS updatedAt FROM evidence_video_clips WHERE bundle_id=?").bind(bundleId).all<EvidenceVideoClipRecord>()).results}
  async findSourceByHash(bundleId:string,hash:string){return this.db.prepare("SELECT id,bundle_id AS bundleId,original_file_name AS originalFileName,media_type AS mediaType,byte_size AS byteSize,content_hash AS contentHash,storage_key AS storageKey,extracted_text_key AS extractedTextKey,extraction_status AS extractionStatus,extraction_error AS extractionError FROM evidence_sources WHERE bundle_id=? AND content_hash=?").bind(bundleId,hash).first<StoredEvidenceFile>()}
  async describeDeleteImpact(sourceId:string){const [cards,scenarios]=await Promise.all([this.db.prepare("SELECT DISTINCT c.id FROM tactic_cards c JOIN tactic_card_citations x ON x.card_id=c.id JOIN evidence_chunks h ON h.id=x.chunk_id WHERE h.source_id=?").bind(sourceId).all<{id:string}>(),this.db.prepare("SELECT DISTINCT s.id FROM scenario_evidence_sources x JOIN scenarios s ON s.id=x.scenario_id WHERE x.source_id=? AND s.review_status='draft'").bind(sourceId).all<{id:string}>()]);return{sourceId,cardIds:cards.results.map(x=>x.id),scenarioDraftIds:scenarios.results.map(x=>x.id)}}
  async createBundle(b:EvidenceBundleRecord,a:EvidenceAuditEventInput){await this.db.batch([this.db.prepare("INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(b.id,b.title,b.purpose,b.version,b.contentVersion,b.createdAt,b.updatedAt),this.audit(a,"EXISTS (SELECT 1 FROM evidence_bundles WHERE id=?)",[b.id])])}
  async applyMutation(mutation: EvidenceMutation) {
    const current = mutation.current;
    const next = mutation.next;
    const oldState = [current.id, current.version, current.contentVersion];
    const statements: EvidenceD1Statement[] = [];
    let dependentGuard = guard;
    let dependentGuardValues: unknown[] = oldState;

    if (mutation.sourceToDelete) {
      // D1 does not fail a batch when a required DELETE affects zero rows. This
      // durable receipt materializes target existence so every later write,
      // including the final CAS, can depend on the same SQL precondition.
      const receiptId = mutation.audit.id;
      statements.push(this.db.prepare(
        `INSERT INTO evidence_mutation_receipts (id,bundle_id,source_id,created_at)
          SELECT ?,?,?,? FROM evidence_sources
          WHERE id=? AND bundle_id=? AND ${guard}`,
      ).bind(
        receiptId, current.id, mutation.sourceToDelete, next.updatedAt,
        mutation.sourceToDelete, current.id, ...oldState,
      ));
      dependentGuard = `${guard} AND EXISTS (
        SELECT 1 FROM evidence_mutation_receipts
        WHERE id=? AND bundle_id=? AND source_id=?
      )`;
      dependentGuardValues = [...oldState, receiptId, current.id, mutation.sourceToDelete];
    }

    if (mutation.sourceToInsert) {
      const source = mutation.sourceToInsert;
      statements.push(this.db.prepare(
        `INSERT INTO evidence_sources (id,bundle_id,original_file_name,media_type,byte_size,content_hash,storage_key,extracted_text_key,extraction_status,extraction_error,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,
      ).bind(
        source.id, source.bundleId, source.originalFileName, source.mediaType, source.byteSize,
        source.contentHash, source.storageKey, source.extractedTextKey, source.extractionStatus,
        source.extractionError, next.updatedAt, next.updatedAt, ...oldState,
      ));
    }
    if (mutation.sourceToDelete) {
      statements.push(this.db.prepare(
        `DELETE FROM evidence_sources WHERE id=? AND bundle_id=? AND ${dependentGuard}`,
      ).bind(mutation.sourceToDelete, current.id, ...dependentGuardValues));
    }
    if (mutation.clipToInsert) {
      const clip = mutation.clipToInsert;
      statements.push(this.db.prepare(
        `INSERT INTO evidence_video_clips (id,bundle_id,url,start_ms,end_ms,observation,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`,
      ).bind(
        clip.id, clip.bundleId, clip.url, clip.startMs, clip.endMs, clip.observation,
        clip.createdAt, clip.updatedAt, ...oldState,
      ));
    }

    statements.push(
      this.db.prepare(
        `UPDATE evidence_analysis_jobs
          SET is_stale=1,
            status=CASE WHEN status IN ('queued','running','review_ready') THEN 'failed' ELSE status END,
            error_message=CASE WHEN status IN ('queued','running','review_ready') THEN 'evidence version superseded' ELSE error_message END,
            updated_at=?
          WHERE bundle_id=? AND input_version<>? AND ${dependentGuard}`,
      ).bind(next.updatedAt, current.id, next.contentVersion, ...dependentGuardValues),
      this.db.prepare(
        `UPDATE tactic_cards
          SET is_stale=1,
            status=CASE WHEN status IN ('analysis_draft','owner_reviewed','coach_reviewed') THEN 'held' ELSE status END,
            updated_at=?
          WHERE bundle_id=? AND bundle_version<>? AND ${dependentGuard}`,
      ).bind(next.updatedAt, current.id, next.contentVersion, ...dependentGuardValues),
      this.audit(mutation.audit, dependentGuard, dependentGuardValues),
      // D1 batch statements execute sequentially. The CAS must remain last so
      // every dependent old-state guard is true on success and false on a miss.
      this.db.prepare(
        `UPDATE evidence_bundles
          SET title=?,purpose=?,version=?,content_version=?,updated_at=?
          WHERE id=? AND version=? AND content_version=?${mutation.sourceToDelete ? ` AND EXISTS (
            SELECT 1 FROM evidence_mutation_receipts
            WHERE id=? AND bundle_id=? AND source_id=?
          )` : ""}`,
      ).bind(
        next.title, next.purpose, next.version, next.contentVersion, next.updatedAt, ...oldState,
        ...(mutation.sourceToDelete ? [mutation.audit.id, current.id, mutation.sourceToDelete] : []),
      ),
    );

    const results = await this.db.batch(statements);
    return (results.at(-1)?.meta?.changes ?? 0) === 1;
  }
  private audit(a:EvidenceAuditEventInput,w:string,v:unknown[]){return this.db.prepare(`INSERT INTO evidence_audit_events (id,bundle_id,actor_user_id,action,target_type,target_id,details_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${w}`).bind(a.id,a.bundleId,a.actorUserId,a.action,a.targetType,a.targetId,a.detailsJson,a.createdAt,...v)}
}
export class EvidenceService {
  constructor(private readonly d:{repository:EvidenceServiceRepository;settings:EvidenceAnalysisSettings;fileStore?:Pick<EvidenceFileStore,"deleteFilePairWithCompensation">;now?:()=>number;newId?:()=>string}){}
  async createBundle(input:unknown,admin:EvidenceAdmin){const x=parseBundleInput(input),now=this.now(),b:EvidenceBundleRecord={id:this.id(),...x,version:1,contentVersion:await this.hash(x.purpose,[],[]),createdAt:now,updatedAt:now};await this.d.repository.createBundle(b,this.audit(b,admin,"bundle.created","bundle",b.id,x,now));return b}
  async updateBundle(id:string,u:EvidenceBundleUpdate,a:EvidenceAdmin){const c=await this.need(id),x=parseBundleInput({title:u.title??c.title,purpose:u.purpose??c.purpose}),changed=x.purpose!==c.purpose,n={...c,...x,version:changed?c.version+1:c.version,contentVersion:changed?await this.hash(x.purpose,await this.d.repository.listSources(id),await this.d.repository.listVideoClips(id)):c.contentVersion,updatedAt:this.now()};await this.commit({current:c,next:n,audit:this.audit(n,a,"bundle.updated","bundle",id,{contentChanged:changed},n.updatedAt)});return n}
  async addVideoClip(id:string,input:unknown,a:EvidenceAdmin){const c=await this.need(id),now=this.now(),x:EvidenceVideoClipRecord={id:this.id(),bundleId:id,...parseVideoClip(input),createdAt:now,updatedAt:now},n={...c,version:c.version+1,contentVersion:await this.hash(c.purpose,await this.d.repository.listSources(id),[...await this.d.repository.listVideoClips(id),x]),updatedAt:now};await this.commit({current:c,next:n,clipToInsert:x,audit:this.audit(n,a,"video_clip.added","video_clip",x.id,x,now)});return n}
  sourceRegistration(a:EvidenceAdmin){return{findExisting:(b:string,h:string)=>this.d.repository.findSourceByHash(b,h),register:(s:StoredEvidenceFile)=>this.addSource(s,a)}}
  async addSource(s:StoredEvidenceFile,a:EvidenceAdmin){const c=await this.need(s.bundleId),now=this.now(),n={...c,version:c.version+1,contentVersion:await this.hash(c.purpose,[...await this.d.repository.listSources(c.id),s],await this.d.repository.listVideoClips(c.id)),updatedAt:now};await this.commit({current:c,next:n,sourceToInsert:s,audit:this.audit(n,a,"source.added","source",s.id,{contentHash:s.contentHash},now)});return s}
  async describeDeleteImpact(id:string){return this.d.repository.describeDeleteImpact(id)}
  async removeSource(id: string, admin: EvidenceAdmin) {
    const source = await this.d.repository.findSource(id);
    if (!source) throw new Error("근거 파일을 찾을 수 없습니다.");
    this.links(await this.describeDeleteImpact(id));
    if (!this.d.fileStore) throw new Error("근거 파일 저장소가 구성되지 않았습니다.");

    return this.d.fileStore.deleteFilePairWithCompensation(
      source.storageKey,
      source.extractedTextKey,
      async () => {
        this.links(await this.describeDeleteImpact(id));
        const current = await this.need(source.bundleId);
        const now = this.now();
        const next = {
          ...current,
          version: current.version + 1,
          contentVersion: await this.hash(
            current.purpose,
            (await this.d.repository.listSources(current.id)).filter((item) => item.id !== id),
            await this.d.repository.listVideoClips(current.id),
          ),
          updatedAt: now,
        };
        try {
          await this.commit({
            current,
            next,
            sourceToDelete: id,
            audit: this.audit(next, admin, "source.removed", "source", id, {}, now),
          });
        } catch (error) {
          // A relation can appear after both advisory impact checks. Translate
          // the authoritative FK/trigger rollback into the public domain error.
          this.links(await this.describeDeleteImpact(id));
          throw error;
        }
        return next;
      },
      async () => await this.d.repository.findSource(id) !== null,
    );
  }
  async getBundleForAdmin(id:string,a:EvidenceAdmin):Promise<EvidenceBundleDetail|null>{void a;const b=await this.d.repository.getBundle(id);return b?{...b,sources:await this.d.repository.listSources(id),videoClips:await this.d.repository.listVideoClips(id)}:null} async listBundlesForAdmin(a:EvidenceAdmin){void a;return this.d.repository.listBundles()}
  private async commit(m:EvidenceMutation){if(!await this.d.repository.applyMutation(m))throw new EvidenceConflictError()} private async need(id:string){const b=await this.d.repository.getBundle(id);if(!b)throw new Error("근거 묶음을 찾을 수 없습니다.");return b} private hash(p:string,s:Pick<StoredEvidenceFile,"contentHash">[],c:VideoClipInput[]){return computeEvidenceVersion({purpose:p,sourceHashes:s.map(x=>x.contentHash),clips:c,...this.d.settings})} private links(x:EvidenceDeleteImpact){if(x.cardIds.length||x.scenarioDraftIds.length)throw new Error("연결된 카드 또는 시나리오 초안이 있어 근거를 삭제할 수 없습니다.")} private audit(b:EvidenceBundleRecord,a:EvidenceAdmin,ac:string,t:string,id:string,o:object,at:number):EvidenceAuditEventInput{return{id:this.id(),bundleId:b.id,actorUserId:a.userId,action:ac,targetType:t,targetId:id,detailsJson:JSON.stringify(o),createdAt:at}}private now(){return this.d.now?.()??Date.now()}private id(){return this.d.newId?.()??crypto.randomUUID()}
}
