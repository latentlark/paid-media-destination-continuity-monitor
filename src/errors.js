export class FatalInputError extends Error {
    constructor(message, details = undefined) {
        super(message);
        this.name = 'FatalInputError';
        this.details = details;
    }
}
