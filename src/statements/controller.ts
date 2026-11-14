import {
  Inject,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from '../auth/auth';
import { Statements } from './service';
import { MemoryUpload, UploadRequest } from './upload';
@ApiTags('Statements')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('moneylens/statements')
export class StatementsController {
  constructor(@Inject(Statements) private readonly statements: Statements) {}
  @Post('extract')
  @UseInterceptors(MemoryUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Extract a statement in memory; document is never retained. Extraction failure requires reupload.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['document'],
      properties: { document: { type: 'string', format: 'binary' } },
    },
  })
  extract(
    @CurrentUser() userId: string,
    @Req() req: UploadRequest,
    @Query('retry') retry?: string,
  ) {
    return this.statements.extract(
      userId,
      req.documentBuffer!,
      req.processingSignal,
      retry === 'true',
      req.processingDeadlineAt,
    );
  }
  @Get(':id')
  status(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.statements.result(userId, id);
  }
  @Get(':id/transactions')
  rows(@CurrentUser() userId: string, @Param('id') id: string, @Query('cursor') cursor?: string) {
    return this.statements.rows(userId, id, cursor);
  }
  @Post(':id/classify')
  @HttpCode(202)
  classify(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.statements.classify(userId, id);
  }
}
