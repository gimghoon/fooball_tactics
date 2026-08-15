import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(), title: text("title").notNull(), formation: text("formation").notNull(),
  reviewStatus: text("review_status", { enum: ["draft", "pending", "reviewed"] }).notNull().default("pending"),
  sourceTitle: text("source_title"), sourceUrl: text("source_url"), reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
});

export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["fixo", "ala", "pivo", "recap"] }).notNull(),
  principle: text("principle", { enum: ["width", "support", "pivot", "transition"] }).notNull(),
  prompt: text("prompt").notNull(), hint: text("hint").notNull(), explanation: text("explanation").notNull(),
  pitchJson: text("pitch_json").notNull(), answerJson: text("answer_json").notNull(), contentJson: text("content_json").notNull().default(""),
  reviewStatus: text("review_status", { enum: ["draft", "pending", "reviewed"] }).notNull().default("pending"), orderIndex: integer("order_index").notNull(),
}, (table) => [index("idx_scenarios_campaign_order").on(table.campaignId, table.orderIndex)]);

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(), inviteCode: text("invite_code").notNull(), campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  ownerParticipantId: text("owner_participant_id"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_rooms_invite_code").on(table.inviteCode)]);

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  nickname: text("nickname").notNull(), tokenHash: text("token_hash").notNull(), isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  completedStage: text("completed_stage").notNull().default("intro"), removedAt: integer("removed_at", { mode: "timestamp_ms" }), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_participants_room_nickname").on(table.roomId, table.nickname)]);

export const attempts = sqliteTable("attempts", {
  eventId: text("event_id").primaryKey(), participantId: text("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
  scenarioId: text("scenario_id").notNull().references(() => scenarios.id), principle: text("principle").notNull(), correct: integer("correct", { mode: "boolean" }).notNull(),
  touchX: integer("touch_x").notNull(), touchY: integer("touch_y").notNull(), actionType: text("action_type", { enum: ["pass", "dribble", "move"] }).notNull().default("pass"), targetPlayerId: text("target_player_id"), pathJson: text("path_json"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_attempts_participant").on(table.participantId)]);

export const mastery = sqliteTable("mastery", {
  participantId: text("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }), principle: text("principle").notNull(),
  score: integer("score").notNull().default(0), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_mastery_participant_principle").on(table.participantId, table.principle)]);

export const reflections = sqliteTable("reflections", {
  id: text("id").primaryKey(), participantId: text("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
  missionId: text("mission_id").notNull(), result: text("result", { enum: ["worked", "difficult"] }).notNull(), note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_reflections_participant").on(table.participantId)]);
