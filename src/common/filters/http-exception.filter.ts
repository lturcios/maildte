import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(HttpExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const { statusCode, body } = this.buildErrorBody(exception);

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ err: exception }, 'Error no controlado');
    }

    response.status(statusCode).json(body);
  }

  private buildErrorBody(exception: unknown): { statusCode: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'object' && response !== null && 'error' in response) {
        const { error, message } = response as { error: unknown; message: unknown };
        return {
          statusCode,
          body: {
            statusCode,
            error: String(error),
            message: this.flattenMessage(message),
          },
        };
      }

      return {
        statusCode,
        body: {
          statusCode,
          error: this.defaultErrorCode(statusCode),
          message: this.flattenMessage(typeof response === 'string' ? response : exception.message),
        },
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'INTERNAL_ERROR',
        message: 'Ocurrió un error interno inesperado',
      },
    };
  }

  private flattenMessage(message: unknown): string {
    if (Array.isArray(message)) {
      return message.join(', ');
    }
    return String(message);
  }

  private defaultErrorCode(statusCode: number): string {
    switch (statusCode) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.GONE:
        return 'GONE';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'UNPROCESSABLE_ENTITY';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
