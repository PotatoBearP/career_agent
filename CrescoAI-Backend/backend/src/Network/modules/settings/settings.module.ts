import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiSettingsEntity } from './entities/api-settings.entity';
import { UserEntity } from '../user/entities/user.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { McpSettingEntity } from './entities/mcp-setting.entity';
import { GithubMcpRuntimeService } from './github-mcp-runtime.service';

@Module({
  imports: [TypeOrmModule.forFeature([ApiSettingsEntity, McpSettingEntity, UserEntity])],
  controllers: [SettingsController],
  providers: [SettingsService, GithubMcpRuntimeService],
  exports: [SettingsService, GithubMcpRuntimeService],
})
export class SettingsModule {}
