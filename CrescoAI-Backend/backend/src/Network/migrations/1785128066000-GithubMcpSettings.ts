import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GithubMcpSettings1785128066000 implements MigrationInterface {
  name = 'GithubMcpSettings1785128066000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "mcp_settings" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "userId" integer NOT NULL,
      "provider" text NOT NULL DEFAULT ('github'),
      "enabled" boolean NOT NULL DEFAULT (0),
      "personalAccessToken" text,
      "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
      "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
    )`);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "IDX_mcp_settings_user_provider_unique" ON "mcp_settings" ("userId", "provider")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_mcp_settings_user_provider_unique"');
    await queryRunner.query('DROP TABLE "mcp_settings"');
  }
}
