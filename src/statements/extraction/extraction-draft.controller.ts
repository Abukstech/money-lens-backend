import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard, CurrentUser } from '../../auth/auth';
import { MemoryUpload, UploadRequest } from '../upload';

import { ExtractionDraftService, type ExtractionActorContext } from './extraction-draft.service';

@ApiTags('Statement Extraction Drafts')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('moneylens/statements/extraction-drafts')
export class ExtractionDraftController {
  constructor(
    @Inject(ExtractionDraftService)
    private readonly drafts: ExtractionDraftService,
  ) {}

  /**
   * For now, each user has a private extraction scope.
   *
   * Later we'll replace this with authorized
   * client/workspace membership resolution.
   */
  private resolveActor(userId: string): ExtractionActorContext {
    if (!userId || !userId.trim()) {
      throw new UnauthorizedException('Authentication required');
    }

    return {
      userId,
      accountScopeId: `user:${userId}`,
    };
  }

  @Post()
  @UseInterceptors(MemoryUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Extract a PDF and save its transactions as a reviewable draft',
    description:
      'Processes the PDF in memory. Persists extracted transactions, validation evidence and the document fingerprint, but not the PDF file itself.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['document'],
      properties: {
        document: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async create(@CurrentUser() userId: string, @Req() req: UploadRequest) {
    const actor = this.resolveActor(userId);

    if (!req.documentBuffer?.length) {
      throw new BadRequestException('A PDF document is required');
    }

    return this.drafts.createFromPdf(
      req.documentBuffer,
      actor,
      req.processingSignal,
      req.processingDeadlineAt,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Retrieve an extraction draft belonging to the authenticated user',
  })
  async findById(@CurrentUser() userId: string, @Param('id') draftId: string) {
    const actor = this.resolveActor(userId);

    return this.drafts.findById(draftId, actor);
  }

  @Patch(':id/rows/:rowId')
  @ApiOperation({
    summary: 'Correct an extracted transaction and invalidate previous validation',
  })
  async correctRow(
    @CurrentUser() userId: string,
    @Param('id') draftId: string,
    @Param('rowId') rowId: string,
    @Body() payload: unknown,
  ) {
    const actor = this.resolveActor(userId);

    return this.drafts.correctRow(draftId, rowId, actor, payload);
  }
}
