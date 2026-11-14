import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  ConsoleLogger,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Config } from '../../common/config';
import { ProviderError } from '../../common/provider-http';
import { OcrClient } from '../ocr';
import { PaddleOcrClient } from '../paddle-ocr';
import type { DateOrder } from './date-normalizer';
import { prepareStatement } from './engine';
import { InvalidStatementPdf } from './pdf-reader';

@Injectable()
export class StatementExtractor {
  private readonly logger = new ConsoleLogger(StatementExtractor.name);

  constructor(
    @Inject(Config) private readonly config: Config,
    @Inject(OcrClient) private readonly ocr: OcrClient,
    @Inject(PaddleOcrClient) private readonly paddle: PaddleOcrClient,
  ) {}

  async extract(
    pdf: Buffer,
    signal: AbortSignal,
    dateOrder?: DateOrder,
    deadlineAt = Date.now() + this.config.values.OCR_DEADLINE_MS,
  ) {
    const scopedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())),
    ]);
    const provider = this.config.values.PADDLE_OCR_URL ? 'paddleocr' : 'mistral';
    try {
      scopedSignal.throwIfAborted();
      if (pdf.subarray(0, 5).toString() !== '%PDF-') {
        throw new BadRequestException('PDF_ONLY_SUPPORTED');
      }

      const { totalPages, extractLocal, extractRecognized, evaluate } = await prepareStatement(
        pdf,
        scopedSignal,
        {
          dateOrder,
        },
      );
      const checkDeadline = () => {
        scopedSignal.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new RequestTimeoutException('EXTRACTION_CANCELLED');
      };
      checkDeadline();

      if (!this.config.values.PADDLE_OCR_URL && !this.config.values.MISTRAL_OCR_ENABLED) {
        const local = extractLocal();
        checkDeadline();
        return { ...local, source: 'local' as const };
      }

      let ocr: ReturnType<typeof evaluate>;
      try {
        if (provider === 'paddleocr') {
          const pages = await this.paddle.read(pdf, totalPages, scopedSignal);
          checkDeadline();
          ocr = extractRecognized(pages);
        } else {
          const { rows, rejectedRows } = await this.ocr.extract(
            pdf,
            'application/pdf',
            scopedSignal,
            totalPages,
            deadlineAt,
          );
          checkDeadline();
          ocr = evaluate(
            rows.map(
              ({ accountIdentifier: _account, recipientIdentifier: _recipient, ...row }) => ({
                ...row,
                balance: row.balance ?? null,
                reference: row.reference ?? null,
              }),
            ),
            rejectedRows,
          );
        }
      } catch (error) {
        checkDeadline();
        if (!(error instanceof ProviderError || error instanceof ServiceUnavailableException)) {
          throw error;
        }
        if (error instanceof ProviderError) {
          this.logger.warn({
            provider,
            code: error.code,
            upstreamStatus: error.status,
            upstreamCode: error.upstreamCode,
          });
        } else {
          const response = error.getResponse();
          const code =
            typeof response === 'object' && 'message' in response ? response.message : '';
          if (
            code === 'OCR_NOT_CONFIGURED' ||
            code === 'PADDLE_OCR_NOT_CONFIGURED' ||
            code === 'PROVIDER_PRIVACY_EVIDENCE_REQUIRED' ||
            code === 'OCR_RATE_LIMITED'
          ) {
            this.logger.warn({ provider, code });
          }
        }
        const local = extractLocal();
        checkDeadline();
        if (local.review.automaticAcceptanceEligible) {
          return { ...local, source: 'local' as const };
        }
        throw error;
      }

      checkDeadline();
      if (ocr.review.automaticAcceptanceEligible) return { ...ocr, source: provider };

      const local = extractLocal();
      checkDeadline();
      const localValidRows = local.rows.length - local.diagnostics.invalidRows;
      const preferOcr =
        !local.review.automaticAcceptanceEligible &&
        ocr.rows.length > 0 &&
        ocr.rows.length >= localValidRows;
      this.logger.warn({
        provider,
        code: 'OCR_VALIDATION_FAILED',
        selectedSource: preferOcr ? provider : 'local',
        ocrRows: ocr.rows.length,
        localValidRows,
        reasons: ocr.review.reasons,
        parserIssueCodes: [...new Set(ocr.diagnostics.parserIssues.map(({ code }) => code))],
        coverageIssueCodes: [...new Set(ocr.diagnostics.coverage.issues.map(({ code }) => code))],
      });
      if (preferOcr) {
        return { ...ocr, source: provider };
      }
      return { ...local, source: 'local' as const };
    } catch (error) {
      if (scopedSignal.aborted || Date.now() >= deadlineAt) {
        throw new RequestTimeoutException('EXTRACTION_CANCELLED');
      }
      if (error instanceof InvalidStatementPdf) throw new BadRequestException(error.code);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('EXTRACTION_FAILED_REUPLOAD_REQUIRED');
    }
  }
}
