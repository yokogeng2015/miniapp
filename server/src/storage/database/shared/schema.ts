import { pgTable, serial, timestamp, varchar, integer, index } from "drizzle-orm/pg-core"



export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const studyUsers = pgTable(
	"study_users",
	{
		id: varchar("id", { length: 36 }).primaryKey(),
		device_id: varchar("device_id", { length: 64 }).notNull().unique(),
		total_points: integer("total_points").default(0).notNull(),
		correct_count: integer("correct_count").default(0).notNull(),
		total_count: integer("total_count").default(0).notNull(),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("study_users_device_id_idx").on(table.device_id),
		index("study_users_updated_at_idx").on(table.updated_at),
	]
);