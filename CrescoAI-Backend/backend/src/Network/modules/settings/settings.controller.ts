import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SettingsService } from './settings.service';
import { UpdateApiSettingsDto } from './dto/update-api-settings.dto';
import { UpdateUsernameDto } from './dto/update-username.dto';
import { TestGithubMcpSettingDto, UpdateGithubMcpSettingDto } from './dto/update-github-mcp-setting.dto';
import { GithubMcpRuntimeService } from './github-mcp-runtime.service';

@Controller('api/career-agent/settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly githubMcpRuntimeService: GithubMcpRuntimeService,
  ) {}

  @Get()
  get(@Req() req: Request) {
    return this.settingsService.getSettings(req.userId!);
  }

  @Patch('username')
  updateUsername(@Req() req: Request, @Body() dto: UpdateUsernameDto) {
    return this.settingsService.updateUsername(req.userId!, dto);
  }

  @Get('api')
  listApiSettings(@Req() req: Request) {
    return this.settingsService.listApiSettings(req.userId!);
  }

  @Put('api')
  upsertApiSetting(@Req() req: Request, @Body() dto: UpdateApiSettingsDto) {
    return this.settingsService.upsertSettings(req.userId!, dto);
  }

  @Post('api')
  @HttpCode(HttpStatus.OK)
  createOrUpdateApiSetting(@Req() req: Request, @Body() dto: UpdateApiSettingsDto) {
    return this.settingsService.upsertSettings(req.userId!, dto);
  }

  @Post('api/test')
  @HttpCode(HttpStatus.OK)
  testApiSetting(@Req() req: Request, @Body() dto: UpdateApiSettingsDto) {
    return this.settingsService.testApiSetting(req.userId!, dto);
  }

  @Get('mcp/github')
  getGithubMcpSetting(@Req() req: Request) {
    return this.githubMcpRuntimeService.getView(req.userId!);
  }

  @Put('mcp/github')
  updateGithubMcpSetting(
    @Req() req: Request,
    @Body() dto: UpdateGithubMcpSettingDto,
  ) {
    return this.githubMcpRuntimeService.save(req.userId!, dto);
  }

  @Post('mcp/github/test')
  @HttpCode(HttpStatus.OK)
  testGithubMcpSetting(
    @Req() req: Request,
    @Body() dto: TestGithubMcpSettingDto,
  ) {
    return this.githubMcpRuntimeService.test(req.userId!, dto.personalAccessToken);
  }

  @Delete('mcp/github')
  deleteGithubMcpSetting(@Req() req: Request) {
    return this.githubMcpRuntimeService.remove(req.userId!);
  }
}
