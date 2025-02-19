import to from "await-to-js";
import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import Secret, { ISecret } from "../../models/secret";
import { CreateSecretRequestBody, ModifySecretRequestBody, SanitizedSecretForCreate, SanitizedSecretModify } from "../../types/secret";
const { ValidationError } = mongoose.Error;
import { BadRequestError, InternalServerError, UnauthorizedRequestError, ValidationError as RouteValidationError } from '../../utils/errors';
import { AnyBulkWriteOperation } from 'mongodb';
import { SECRET_PERSONAL, SECRET_SHARED } from "../../variables";
import { getPostHogClient } from '../../services';

/**
 * Create secret for workspace with id [workspaceId] and environment [environment]
 * @param req 
 * @param res 
 */
export const createSecret = async (req: Request, res: Response) => {
  const postHogClient = getPostHogClient();
  const secretToCreate: CreateSecretRequestBody = req.body.secret;
  const { workspaceId, environment } = req.params
  const sanitizedSecret: SanitizedSecretForCreate = {
    secretKeyCiphertext: secretToCreate.secretKeyCiphertext,
    secretKeyIV: secretToCreate.secretKeyIV,
    secretKeyTag: secretToCreate.secretKeyTag,
    secretKeyHash: secretToCreate.secretKeyHash,
    secretValueCiphertext: secretToCreate.secretValueCiphertext,
    secretValueIV: secretToCreate.secretValueIV,
    secretValueTag: secretToCreate.secretValueTag,
    secretValueHash: secretToCreate.secretValueHash,
    secretCommentCiphertext: secretToCreate.secretCommentCiphertext,
    secretCommentIV: secretToCreate.secretCommentIV,
    secretCommentTag: secretToCreate.secretCommentTag,
    secretCommentHash: secretToCreate.secretCommentHash,
    workspace: new Types.ObjectId(workspaceId),
    environment,
    type: secretToCreate.type,
    user: new Types.ObjectId(req.user._id)
  }


  const [error, secret] = await to(Secret.create(sanitizedSecret).then())
  if (error instanceof ValidationError) {
    throw RouteValidationError({ message: error.message, stack: error.stack })
  }

  if (postHogClient) {
    postHogClient.capture({
      event: 'secrets added',
      distinctId: req.user.email,
      properties: {
        numberOfSecrets: 1,
        workspaceId,
        environment,
        channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
        userAgent: req.headers?.['user-agent']
      }
    });
  }

  res.status(200).send({
    secret
  })
}

/**
 * Create many secrets for workspace wiht id [workspaceId] and environment [environment]
 * @param req 
 * @param res 
 */
export const createSecrets = async (req: Request, res: Response) => {
  const postHogClient = getPostHogClient();
  const secretsToCreate: CreateSecretRequestBody[] = req.body.secrets;
  const { workspaceId, environment } = req.params
  const sanitizedSecretesToCreate: SanitizedSecretForCreate[] = []

  secretsToCreate.forEach(rawSecret => {
    const safeUpdateFields: SanitizedSecretForCreate = {
      secretKeyCiphertext: rawSecret.secretKeyCiphertext,
      secretKeyIV: rawSecret.secretKeyIV,
      secretKeyTag: rawSecret.secretKeyTag,
      secretKeyHash: rawSecret.secretKeyHash,
      secretValueCiphertext: rawSecret.secretValueCiphertext,
      secretValueIV: rawSecret.secretValueIV,
      secretValueTag: rawSecret.secretValueTag,
      secretValueHash: rawSecret.secretValueHash,
      secretCommentCiphertext: rawSecret.secretCommentCiphertext,
      secretCommentIV: rawSecret.secretCommentIV,
      secretCommentTag: rawSecret.secretCommentTag,
      secretCommentHash: rawSecret.secretCommentHash,
      workspace: new Types.ObjectId(workspaceId),
      environment,
      type: rawSecret.type,
      user: new Types.ObjectId(req.user._id)
    }

    sanitizedSecretesToCreate.push(safeUpdateFields)
  })

  const [bulkCreateError, secrets] = await to(Secret.insertMany(sanitizedSecretesToCreate).then())
  if (bulkCreateError) {
    if (bulkCreateError instanceof ValidationError) {
      throw RouteValidationError({ message: bulkCreateError.message, stack: bulkCreateError.stack })
    }

    throw InternalServerError({ message: "Unable to process your batch create request. Please try again", stack: bulkCreateError.stack })
  }

  if (postHogClient) {
    postHogClient.capture({
      event: 'secrets added',
      distinctId: req.user.email,
      properties: {
        numberOfSecrets: (secretsToCreate ?? []).length,
        workspaceId,
        environment,
        channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
        userAgent: req.headers?.['user-agent']
      }
    });
  }

  res.status(200).send({
    secrets
  })
}

/**
 * Delete secrets in workspace with id [workspaceId] and environment [environment]
 * @param req 
 * @param res 
 */
export const deleteSecrets = async (req: Request, res: Response) => {
  const postHogClient = getPostHogClient();
  const { workspaceId, environmentName } = req.params
  const secretIdsToDelete: string[] = req.body.secretIds

  const [secretIdsUserCanDeleteError, secretIdsUserCanDelete] = await to(Secret.find({ workspace: workspaceId, environment: environmentName }, { _id: 1 }).then())
  if (secretIdsUserCanDeleteError) {
    throw InternalServerError({ message: `Unable to fetch secrets you own: [error=${secretIdsUserCanDeleteError.message}]` })
  }

  const secretsUserCanDeleteSet: Set<string> = new Set(secretIdsUserCanDelete.map(objectId => objectId._id.toString()));
  const deleteOperationsToPerform: AnyBulkWriteOperation<ISecret>[] = []

  let numSecretsDeleted = 0;
  secretIdsToDelete.forEach(secretIdToDelete => {
    if (secretsUserCanDeleteSet.has(secretIdToDelete)) {
      const deleteOperation = { deleteOne: { filter: { _id: new Types.ObjectId(secretIdToDelete) } } }
      deleteOperationsToPerform.push(deleteOperation)
      numSecretsDeleted++;
    } else {
      throw RouteValidationError({ message: "You cannot delete secrets that you do not have access to" })
    }
  })

  const [bulkDeleteError, bulkDelete] = await to(Secret.bulkWrite(deleteOperationsToPerform).then())
  if (bulkDeleteError) {
    if (bulkDeleteError instanceof ValidationError) {
      throw RouteValidationError({ message: "Unable to apply modifications, please try again", stack: bulkDeleteError.stack })
    }
    throw InternalServerError()
  }

  if (postHogClient) {
    postHogClient.capture({
      event: 'secrets deleted',
      distinctId: req.user.email,
      properties: {
        numberOfSecrets: numSecretsDeleted,
        environment: environmentName,
        workspaceId,
        channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
        userAgent: req.headers?.['user-agent']
      }
    });
  }

  res.status(200).send()
}

/**
 * Delete secret with id [secretId]
 * @param req 
 * @param res
 */
export const deleteSecret = async (req: Request, res: Response) => {
  const postHogClient = getPostHogClient();
  await Secret.findByIdAndDelete(req._secret._id)

  if (postHogClient) {
    postHogClient.capture({
      event: 'secrets deleted',
      distinctId: req.user.email,
      properties: {
        numberOfSecrets: 1,
        workspaceId: req._secret.workspace.toString(),
        environment: req._secret.environment,
        channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
        userAgent: req.headers?.['user-agent']
      }
    });
  }

  res.status(200).send({
    secret: req._secret
  })
}

/**
 * Update secrets for workspace with id [workspaceId] and environment [environment]
 * @param req 
 * @param res 
 * @returns 
 */
export const updateSecrets = async (req: Request, res: Response) => {
  const postHogClient = getPostHogClient();
  const { workspaceId, environmentName } = req.params
  const secretsModificationsRequested: ModifySecretRequestBody[] = req.body.secrets;
  const [secretIdsUserCanModifyError, secretIdsUserCanModify] = await to(Secret.find({ workspace: workspaceId, environment: environmentName }, { _id: 1 }).then())
  if (secretIdsUserCanModifyError) {
    throw InternalServerError({ message: "Unable to fetch secrets you own" })
  }

  const secretsUserCanModifySet: Set<string> = new Set(secretIdsUserCanModify.map(objectId => objectId._id.toString()));
  const updateOperationsToPerform: any = []

  secretsModificationsRequested.forEach(userModifiedSecret => {
    if (secretsUserCanModifySet.has(userModifiedSecret._id.toString())) {
      const sanitizedSecret: SanitizedSecretModify = {
        secretKeyCiphertext: userModifiedSecret.secretKeyCiphertext,
        secretKeyIV: userModifiedSecret.secretKeyIV,
        secretKeyTag: userModifiedSecret.secretKeyTag,
        secretKeyHash: userModifiedSecret.secretKeyHash,
        secretValueCiphertext: userModifiedSecret.secretValueCiphertext,
        secretValueIV: userModifiedSecret.secretValueIV,
        secretValueTag: userModifiedSecret.secretValueTag,
        secretValueHash: userModifiedSecret.secretValueHash,
        secretCommentCiphertext: userModifiedSecret.secretCommentCiphertext,
        secretCommentIV: userModifiedSecret.secretCommentIV,
        secretCommentTag: userModifiedSecret.secretCommentTag,
        secretCommentHash: userModifiedSecret.secretCommentHash,
      }

      const updateOperation = { updateOne: { filter: { _id: userModifiedSecret._id, workspace: workspaceId }, update: { $inc: { version: 1 }, $set: sanitizedSecret } } }
      updateOperationsToPerform.push(updateOperation)
    } else {
      throw UnauthorizedRequestError({ message: "You do not have permission to modify one or more of the requested secrets" })
    }
  })

  const [bulkModificationInfoError, bulkModificationInfo] = await to(Secret.bulkWrite(updateOperationsToPerform).then())
  if (bulkModificationInfoError) {
    if (bulkModificationInfoError instanceof ValidationError) {
      throw RouteValidationError({ message: "Unable to apply modifications, please try again", stack: bulkModificationInfoError.stack })
    }

    throw InternalServerError()
  }

  if (postHogClient) {
    postHogClient.capture({
      event: 'secrets modified',
      distinctId: req.user.email,
      properties: {
        numberOfSecrets: (secretsModificationsRequested ?? []).length,
        environment: environmentName,
        workspaceId,
        channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
        userAgent: req.headers?.['user-agent']
      }
    });
  }

  return res.status(200).send()
}

/**
 * Update a secret within workspace with id [workspaceId] and environment [environment]
 * @param req 
 * @param res 
 * @returns 
 */
export const updateSecret = async (req: Request, res: Response) => {
  const postHogClient = getPostHogClient();
  const { workspaceId, environmentName } = req.params
  const secretModificationsRequested: ModifySecretRequestBody = req.body.secret;

  const [secretIdUserCanModifyError, secretIdUserCanModify] = await to(Secret.findOne({ workspace: workspaceId, environment: environmentName }, { _id: 1 }).then())
  if (secretIdUserCanModifyError && !secretIdUserCanModify) {
    throw BadRequestError()
  }

  const sanitizedSecret: SanitizedSecretModify = {
    secretKeyCiphertext: secretModificationsRequested.secretKeyCiphertext,
    secretKeyIV: secretModificationsRequested.secretKeyIV,
    secretKeyTag: secretModificationsRequested.secretKeyTag,
    secretKeyHash: secretModificationsRequested.secretKeyHash,
    secretValueCiphertext: secretModificationsRequested.secretValueCiphertext,
    secretValueIV: secretModificationsRequested.secretValueIV,
    secretValueTag: secretModificationsRequested.secretValueTag,
    secretValueHash: secretModificationsRequested.secretValueHash,
    secretCommentCiphertext: secretModificationsRequested.secretCommentCiphertext,
    secretCommentIV: secretModificationsRequested.secretCommentIV,
    secretCommentTag: secretModificationsRequested.secretCommentTag,
    secretCommentHash: secretModificationsRequested.secretCommentHash,
  }

  const [error, singleModificationUpdate] = await to(Secret.updateOne({ _id: secretModificationsRequested._id, workspace: workspaceId }, { $inc: { version: 1 }, $set: sanitizedSecret }).then())
  if (error instanceof ValidationError) {
    throw RouteValidationError({ message: "Unable to apply modifications, please try again", stack: error.stack })
  }

  if (postHogClient) {
    postHogClient.capture({
      event: 'secrets modified',
      distinctId: req.user.email,
      properties: {
        numberOfSecrets: 1,
        environment: environmentName,
        workspaceId,
        channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
        userAgent: req.headers?.['user-agent']
      }
    });
  }

  return res.status(200).send(singleModificationUpdate)
}

/**
 * Return secrets for workspace with id [workspaceId], environment [environment] and user
 * with id [req.user._id]
 * @param req 
 * @param res 
 * @returns 
 */
export const getSecrets = async (req: Request, res: Response) => {
  const postHogClient = getPostHogClient();
  const { environment } = req.query;
  const { workspaceId } = req.params;

  let userId: Types.ObjectId | undefined = undefined // used for getting personal secrets for user
  let userEmail: Types.ObjectId | undefined = undefined // used for posthog 
  if (req.user) {
    userId = req.user._id;
    userEmail = req.user.email;
  }

  if (req.serviceTokenData) {
    userId = req.serviceTokenData.user._id
    userEmail = req.serviceTokenData.user.email;
  }

  const [err, secrets] = await to(Secret.find(
    {
      workspace: workspaceId,
      environment,
      $or: [{ user: userId }, { user: { $exists: false } }],
      type: { $in: [SECRET_SHARED, SECRET_PERSONAL] }
    }
  ).then())

  if (err) {
    throw RouteValidationError({ message: "Failed to get secrets, please try again", stack: err.stack })
  }

  if (postHogClient) {
    postHogClient.capture({
      event: 'secrets pulled',
      distinctId: userEmail,
      properties: {
        numberOfSecrets: (secrets ?? []).length,
        environment,
        workspaceId,
        channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
        userAgent: req.headers?.['user-agent']
      }
    });
  }

  return res.json(secrets)
}

/**
 * Return secret with id [secretId]
 * @param req 
 * @param res 
 * @returns 
 */
export const getSecret = async (req: Request, res: Response) => {
  // if (postHogClient) {
  //   postHogClient.capture({
  //     event: 'secrets pulled',
  //     distinctId: req.user.email,
  //     properties: {
  //       numberOfSecrets: 1,
  //       workspaceId: req._secret.workspace.toString(),
  //       environment: req._secret.environment,
  //       channel: req.headers?.['user-agent']?.toLowerCase().includes('mozilla') ? 'web' : 'cli',
  //       userAgent: req.headers?.['user-agent']
  //     }
  //   });
  // }

  return res.status(200).send({
    secret: req._secret
  });
}