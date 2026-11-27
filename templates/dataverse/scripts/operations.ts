// How the template generator offers Microsoft Dataverse's Web API. Dataverse
// describes the API only as CSDL, its `$metadata`, which every environment
// serves to signed-in users. Generate from a saved copy of an environment's
// `$metadata`; the generator reads CSDL as an OpenAPI description. The rows of
// every table are read and changed through the same methods, as OData
// addresses them, so tables an environment adds need no regeneration.
//
// Actions and functions that solutions add, such as those named `msdyn_`,
// exist only where the solution is installed and are called with `callAction`.
// Actions Dataverse calls itself, such as `OnExternalCreated`, and those of
// Copilot Studio's own designer are not offered. Operations that change data
// name the change they make, which decides when they ask the user first (see
// src/approval.ts). `create` only adds something new; anything that also
// changes what exists, such as granting privileges, adding members or
// importing over existing customizations, is `update`. Actions that only read
// are `read`.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  // Each environment has its own host, an input of every method.
  source: "https://{environment}/api/data/v9.2/$metadata",
  variables: {
    environment:
      "The environment's host, such as `contoso.api.crm4.dynamics.com`, as `listEnvironments` returns it.",
  },
  service: {
    name: "Dataverse",
    className: "DataverseApi",
    result: "DataverseResult",
    properties: "DataverseProperties",
    typePrefix: "Microsoft.Dynamics.CRM.",
  },
} as const;

// `$metadata` is served to signed-in users of an environment only.
export const download = () => {
  throw new Error("Save an environment's $metadata and pass it as the source file");
};

// OData's and Dataverse's request headers and query options, which the CSDL
// does not describe. Dataverse checks each against the user's privileges, such
// as `prvActOnBehalfOfAnotherUser` for acting for another user.
const prefer = {
  prefer: {
    name: "Prefer",
    description:
      'Preferences, such as `return=representation` to answer the row, `odata.include-annotations="*"` for formatted values, `odata.maxpagesize=50`, `odata.track-changes` for a `@odata.deltaLink` or `respond-async`.',
  },
};

const conditions = {
  ifMatch: {
    name: "If-Match",
    description:
      "`*` to change only an existing row, or the row's `@odata.etag` to change only that version.",
  },
  ifNoneMatch: {
    name: "If-None-Match",
    description: "`*` to only create a row that does not exist.",
  },
};

const unchanged = {
  ifNoneMatch: {
    name: "If-None-Match",
    description:
      "The row's `@odata.etag` to answer `not_modified` when the row has not changed since.",
  },
};

// Every request can act for another user.
const impersonation = {
  callerObjectId: {
    name: "CallerObjectId",
    description: "The Microsoft Entra object ID of a user to act for.",
  },
  mscrmCallerId: {
    name: "MSCRMCallerID",
    description: "The `systemuserid` of a user to act for.",
  },
};

// Every change can skip custom business logic and flows.
const bypass = {
  bypassBusinessLogicExecution: {
    name: "MSCRM.BypassBusinessLogicExecution",
    description:
      "`CustomSync`, `CustomAsync` or `CustomSync,CustomAsync` to skip custom synchronous or asynchronous logic.",
  },
  bypassBusinessLogicExecutionStepIds: {
    name: "MSCRM.BypassBusinessLogicExecutionStepIds",
    description: "The IDs of plug-in steps to skip, separated by commas.",
  },
  bypassCustomPluginExecution: {
    name: "MSCRM.BypassCustomPluginExecution",
    description: "`true` to skip custom synchronous plug-ins.",
  },
  suppressCallbackRegistrationExpanderJob: {
    name: "MSCRM.SuppressCallbackRegistrationExpanderJob",
    description: "`true` to not trigger Power Automate flows.",
  },
};

// Every read can skip the cache of definitions and permissions, and read an
// elastic table's latest writes.
const consistency = {
  consistency: {
    name: "Consistency",
    description:
      "`Strong` to read the latest definitions, labels and permissions instead of cached ones, such as right after changing a table.",
  },
  sessionToken: {
    name: "MSCRM.SessionToken",
    description:
      "An elastic table's `x-ms-session-token` from an earlier change, to read what that change wrote.",
  },
};

// A plug-in reads the tag of the request that runs it.
const tag = {
  name: "tag",
  in: "query",
  description: "A value plug-ins read as the `tag` shared variable.",
  schema: { type: "string" },
};

const unmasked = [
  {
    name: "UnMaskedData",
    in: "query",
    description: "`true` to read masked columns unmasked, which needs the column's privilege.",
    schema: { type: "boolean" },
  },
];

// Definitions carry labels in every installed language unless limited.
const labelLanguages = {
  name: "LabelLanguages",
  in: "query",
  description: "The language codes of the labels to return, such as `1033`, for definitions.",
  schema: { type: "string" },
};

const partition = {
  name: "partitionId",
  in: "query",
  description: "The `partitionid` of an elastic table's row.",
  schema: { type: "string" },
};

// A table, column or other solution component a person creates for a company
// app belongs in that app's solution.
const solution = {
  solutionUniqueName: {
    name: "MSCRM.SolutionUniqueName",
    description:
      "The unique name of the unmanaged solution to add a new table, column, relationship or other solution component to.",
  },
};

// Replacing a definition without merging drops the labels of other languages.
const mergeLabels = {
  mergeLabels: {
    name: "MSCRM.MergeLabels",
    description:
      "`true` to keep the labels of languages the body leaves out, which replacing a definition otherwise removes.",
  },
};

const duplicateDetection = {
  suppressDuplicateDetection: {
    name: "MSCRM.SuppressDuplicateDetection",
    description:
      "`false` to check the row against the environment's duplicate detection rules and refuse a duplicate.",
  },
};

// A person's saved views, and the system views of a table.
const views = [
  {
    name: "savedQuery",
    in: "query",
    description: "The ID of a system view to run, from `savedqueries`.",
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "userQuery",
    in: "query",
    description: "The ID of a view the person saved, from `userqueries`.",
    schema: { type: "string", format: "uuid" },
  },
];

const offered = {
  // The service and its rows of any table
  "service.get": { name: "getServiceDocument" },
  "metadata.get": {
    name: "getMetadata",
    parameters: [
      {
        name: "annotations",
        in: "query",
        description: "`true` to include annotations, such as descriptions of tables.",
        schema: { type: "boolean" },
      },
    ],
  },
  "entitySet.list": { name: "listRows", parameters: [...views, ...unmasked, labelLanguages] },
  "entitySet.count": { name: "countRows" },
  "entitySet.get": {
    name: "getRow",
    headers: unchanged,
    parameters: [...unmasked, partition, labelLanguages],
  },
  // Its address may name an unbound action, so it asks like one.
  "entitySet.create": {
    name: "createRow",
    change: "update",
    headers: { ...solution, ...duplicateDetection },
  },
  "entitySet.update": {
    name: "updateRow",
    change: "update",
    headers: { ...conditions, ...solution, ...duplicateDetection },
  },
  "entitySet.replace": {
    name: "replaceRow",
    change: "update",
    headers: { ...mergeLabels, ...solution },
  },
  "entitySet.delete": { name: "deleteRow", change: "delete", parameters: [partition] },
  "entitySet.getProperty": { name: "getColumn" },
  "entitySet.setProperty": { name: "setColumn", change: "update" },
  "entitySet.deleteProperty": { name: "deleteColumn", change: "delete" },
  "entitySet.getPropertyValue": {
    name: "getColumnContent",
    headers: {
      range: {
        name: "Range",
        description: "Bytes of the content to read, such as `bytes=0-4194303`, for large files.",
      },
    },
    parameters: [
      {
        name: "size",
        in: "query",
        description: "`full` for an image column's full-size image instead of its thumbnail.",
        schema: { type: "string" },
      },
    ],
  },
  "entitySet.uploadProperty": {
    name: "uploadColumnContent",
    change: "update",
    headers: {
      transferMode: {
        name: "x-ms-transfer-mode",
        description:
          "`chunked`, without a body, to start an upload in chunks; the answer's `Location` header is the address of the chunks and `x-ms-chunk-size` their size.",
      },
      fileName: {
        name: "x-ms-file-name",
        description:
          "The file's name, as the chunks of an upload send it; names that are not ASCII go in the `x-ms-file-name` query parameter.",
      },
      contentRange: {
        name: "Content-Range",
        description: "The bytes a chunk holds, such as `bytes 0-4194303/25870370`.",
      },
    },
    parameters: [
      {
        name: "x-ms-file-name",
        in: "query",
        description: "The file's name.",
        schema: { type: "string" },
      },
      {
        name: "sessiontoken",
        in: "query",
        description: "For a chunk, the `sessiontoken` of the `Location` that started the upload.",
        schema: { type: "string" },
      },
    ],
  },
  "entitySet.listRelated": {
    name: "listRelatedRows",
    parameters: [...unmasked, labelLanguages],
  },
  "entitySet.countRelated": { name: "countRelatedRows" },
  "entitySet.createRelated": {
    name: "createRelatedRow",
    change: "create",
    headers: { ...solution, ...duplicateDetection },
  },
  "entitySet.getRelated": {
    name: "getRelatedRow",
    parameters: [...unmasked, labelLanguages],
  },
  "entitySet.replaceRelated": {
    name: "replaceRelatedRow",
    change: "update",
    headers: { ...mergeLabels, ...solution },
  },
  "entitySet.deleteRelated": { name: "deleteRelatedRow", change: "delete" },
  "entitySet.listReferences": { name: "listReferences" },
  "entitySet.associate": { name: "associateRows", change: "update" },
  "entitySet.setReference": { name: "setReference", change: "update" },
  "entitySet.disassociate": { name: "disassociateRows", change: "update" },
  "entitySet.disassociateRelated": { name: "disassociateRelatedRow", change: "update" },

  // Actions and functions the CSDL does not describe, such as a solution's.
  // What an action changes is unknown, so it asks like an update.
  "action.call": { name: "callAction", change: "update" },
  "entitySet.callAction": { name: "callTableAction", change: "update" },
  "entitySet.callRowAction": { name: "callRowAction", change: "update" },
  "function.call": { name: "callFunction" },
  "entitySet.callFunction": { name: "callTableFunction" },
  "entitySet.callRowFunction": { name: "callRowFunction" },

  // Actions and functions
  AddAppComponents: { name: "addAppComponents", change: "update" },
  AddCertificateCredential: { name: "addCertificateCredential", change: "create" },
  AddChannelAccessProfilePrivileges: {
    name: "addChannelAccessProfilePrivileges",
    change: "update",
  },
  AddComponentsToSolutionAsync: { name: "addComponentsToSolutionAsync", change: "update" },
  AddComponentToSolutionAsync: { name: "addComponentToSolutionAsync", change: "update" },
  "team.AddMembersTeam": { name: "addMembersTeam", change: "update" },
  "queue.AddPrincipalToQueue": { name: "addPrincipalToQueue", change: "update" },
  "role.AddPrivilegesRole": { name: "addPrivilegesRole", change: "update" },
  "appointment.AddRecurrence": { name: "addRecurrence", change: "update" },
  "workflow.AddRequiredDesktopFlowComponentsToSolutions": {
    name: "addRequiredDesktopFlowComponentsToSolutions",
    change: "update",
  },
  "desktopflowmodule.AddRequiredUIElementCollectionComponentsToSolutions": {
    name: "addRequiredUIElementCollectionComponentsToSolutions",
    change: "update",
  },
  AddSolutionComponent: { name: "addSolutionComponent", change: "update" },
  "queue.AddToQueue": { name: "addToQueue", change: "update" },
  "systemuser.AddUserToRecordTeam": { name: "addUserToRecordTeam", change: "update" },
  "workqueueitem.AddWorkQueueItemProcessingHistoryEntry": {
    name: "addWorkQueueItemProcessingHistoryEntry",
    change: "create",
  },
  AIClassify: { name: "aIClassify", change: "read" },
  AIExtract: { name: "aIExtract", change: "read" },
  AIModelPublish: { name: "aIModelPublish", change: "update" },
  AIReply: { name: "aIReply", change: "read" },
  AISentiment: { name: "aISentiment", change: "read" },
  AISummarize: { name: "aISummarize", change: "read" },
  AISummarizeRecord: { name: "aISummarizeRecord", change: "read" },
  AITranslate: { name: "aITranslate", change: "read" },
  AnalyzeSentiment: { name: "analyzeSentiment", change: "read" },
  AppendRelatedParty: { name: "appendRelatedParty", change: "update" },
  ApplyRecordCreationAndUpdateRule: { name: "applyRecordCreationAndUpdateRule", change: "update" },
  AutoMapEntity: { name: "autoMapEntity", change: "update" },
  BackgroundSendEmail: { name: "backgroundSendEmail", change: "send" },
  BatchGetFlowMachineStatus: { name: "batchGetFlowMachineStatus", change: "read" },
  BeginMachineImageProvisioning: { name: "beginMachineImageProvisioning", change: "update" },
  Book: { name: "book", change: "create" },
  BulkDelete: { name: "bulkDelete", change: "delete" },
  BulkDetectDuplicates: { name: "bulkDetectDuplicates", change: "create" },
  BulkRemoveActiveCustomizationsAsync: {
    name: "bulkRemoveActiveCustomizationsAsync",
    change: "update",
  },
  BulkRetain: { name: "bulkRetain", change: "update" },
  CalculatePrice: { name: "calculatePrice", change: "update" },
  // Functions that write, though OData functions only read.
  CalculateRollupField: { name: "calculateRollupField", change: "update" },
  CanBeReferenced: { name: "canBeReferenced", change: "read" },
  CanBeReferencing: { name: "canBeReferencing", change: "read" },
  "workflow.CancelAllCloudFlowRuns": { name: "cancelAllCloudFlowRuns", change: "update" },
  "flowsession.CancelDesktopFlowRun": { name: "cancelDesktopFlowRun", change: "update" },
  CanManyToMany: { name: "canManyToMany", change: "read" },
  CardCreateClone: { name: "cardCreateClone", change: "create" },
  CardGetFullJson: { name: "cardGetFullJson", change: "read" },
  CategorizeText: { name: "categorizeText", change: "read" },
  CheckIncomingEmail: { name: "checkIncomingEmail" },
  CheckPromoteEmail: { name: "checkPromoteEmail" },
  "workqueue.ClearWorkQueue": { name: "clearWorkQueue", change: "delete" },
  // A patch locks its parent solution against changes and export.
  CloneAsPatch: { name: "cloneAsPatch", change: "update" },
  CloneAsSolution: { name: "cloneAsSolution", change: "update" },
  "mobileofflineprofile.CloneMobileOfflineProfile": {
    name: "cloneMobileOfflineProfile",
    change: "create",
  },
  CommitAnnotationBlocksUpload: { name: "commitAnnotationBlocksUpload", change: "update" },
  CommitAttachmentBlocksUpload: { name: "commitAttachmentBlocksUpload", change: "update" },
  CommitFileBlocksUpload: { name: "commitFileBlocksUpload", change: "update" },
  CommitToGit: { name: "commitToGit", change: "update" },
  CompoundUpdateDuplicateDetectionRule: {
    name: "compoundUpdateDuplicateDetectionRule",
    change: "update",
  },
  "workqueue.ComputeSlaWorkQueueItem": { name: "computeSlaWorkQueueItem", change: "update" },
  "connectioninstance.ConfirmConsentCode": { name: "confirmConsentCode", change: "update" },
  ConnectToGit: { name: "connectToGit", change: "update" },
  "team.ConvertOwnerTeamToAccessTeam": { name: "convertOwnerTeamToAccessTeam", change: "update" },
  copilotquerytextcontext: { name: "copilotquerytextcontext", change: "read" },
  copilottextdatastatus: { name: "copilottextdatastatus" },
  "systemform.CopySystemForm": { name: "copySystemForm", change: "create" },
  CreateAndSendNewEmail: { name: "createAndSendNewEmail", change: "send" },
  CreateAsyncJobToRevokeInheritedAccess: {
    name: "createAsyncJobToRevokeInheritedAccess",
    change: "update",
  },
  CreateCustomerRelationships: { name: "createCustomerRelationships", change: "create" },
  "recurringappointmentmaster.CreateException": { name: "createException", change: "update" },
  "flowmachinegroup.CreateFlowCredentialApplication": {
    name: "createFlowCredentialApplication",
    change: "create",
  },
  "flowmachinenetwork.CreateFlowMachineNetwork": {
    name: "createFlowMachineNetwork",
    change: "create",
  },
  "flowmachinegroup.CreateFlowSecretServerConnection": {
    name: "createFlowSecretServerConnection",
    change: "create",
  },
  CreateHostedFlowMachineGroup: { name: "createHostedFlowMachineGroup", change: "create" },
  CreateInstance: { name: "createInstance", change: "create" },
  CreateKnowledgeArticleTranslation: {
    name: "createKnowledgeArticleTranslation",
    change: "create",
  },
  CreateKnowledgeArticleVersion: { name: "createKnowledgeArticleVersion", change: "create" },
  "crmbaseentity.CreateMultiple": { name: "createMultiple", change: "create" },
  CreateNPSUserRating: { name: "createNPSUserRating", change: "create" },
  CreatePolymorphicLookupAttribute: { name: "createPolymorphicLookupAttribute", change: "create" },
  "privilegecheckerrun.CreateRoleWithPrivilegeCheckerRun": {
    name: "createRoleWithPrivilegeCheckerRun",
    change: "create",
  },
  CreateRpaBox: { name: "createRpaBox", change: "create" },
  CreateVirtualConnectorTable: { name: "createVirtualConnectorTable", change: "create" },
  "workflow.CreateWorkflowFromTemplate": { name: "createWorkflowFromTemplate", change: "create" },
  DeactivateEntityKey: { name: "deactivateEntityKey", change: "update" },
  DeleteAndPromote: { name: "deleteAndPromote", change: "delete" },
  DeleteAndPromoteAsync: { name: "deleteAndPromoteAsync", change: "delete" },
  DeleteAuditData: { name: "deleteAuditData", change: "delete" },
  DeleteAutomatedPlugin: { name: "deleteAutomatedPlugin", change: "delete" },
  DeleteFile: { name: "deleteFile", change: "delete" },
  "flowmachinegroup.DeleteFlowMachineGroup": { name: "deleteFlowMachineGroup", change: "delete" },
  DeleteInstantPlugin: { name: "deleteInstantPlugin", change: "delete" },
  "crmbaseentity.DeleteMultiple": { name: "deleteMultiple", change: "delete" },
  DeleteOpenInstances: { name: "deleteOpenInstances", change: "delete" },
  DeleteOptionValue: { name: "deleteOptionValue", change: "delete" },
  DeleteRecordChangeHistory: { name: "deleteRecordChangeHistory", change: "delete" },
  "email.DeliverImmediatePromoteEmail": { name: "deliverImmediatePromoteEmail", change: "send" },
  "email.DeliverIncomingEmail": { name: "deliverIncomingEmail", change: "send" },
  "email.DeliverPromoteEmail": { name: "deliverPromoteEmail", change: "send" },
  DeprovisionLanguage: { name: "deprovisionLanguage", change: "delete" },
  "workqueue.Dequeue": { name: "dequeue", change: "update" },
  DetectLanguage: { name: "detectLanguage", change: "read" },
  DisconnectFromGit: { name: "disconnectFromGit", change: "delete" },
  DiscoverFabricAISkills: { name: "discoverFabricAISkills", change: "read" },
  DiscoverFabricWorkspaces: { name: "discoverFabricWorkspaces", change: "read" },
  DownloadBlock: { name: "downloadBlock", change: "read" },
  "report.DownloadReportDefinition": { name: "downloadReportDefinition" },
  DownloadSolutionExportData: { name: "downloadSolutionExportData", change: "read" },
  EmptyRecycleBin: { name: "emptyRecycleBin", change: "delete" },
  EnableEligibleRecycleBinEntities: { name: "enableEligibleRecycleBinEntities", change: "update" },
  "workqueue.EnqueueWorkQueueItem": { name: "enqueueWorkQueueItem", change: "update" },
  ExecuteCosmosSqlQuery: { name: "executeCosmosSqlQuery" },
  ExecuteFxExpression: { name: "executeFxExpression", change: "update" },
  "workflow.ExecuteWorkflow": { name: "executeWorkflow", change: "update" },
  ExecuteWorkIQTask: { name: "executeWorkIQTask", change: "update" },
  "calendar.ExpandCalendar": { name: "expandCalendar" },
  ExportFieldTranslation: { name: "exportFieldTranslation" },
  "importmap.ExportMappingsImportMap": { name: "exportMappingsImportMap", change: "read" },
  ExportRetainedData: { name: "exportRetainedData", change: "read" },
  ExportSolution: { name: "exportSolution", change: "read" },
  ExportSolutionAsync: { name: "exportSolutionAsync", change: "create" },
  ExportSolutionFromGit: { name: "exportSolutionFromGit", change: "read" },
  ExportSolutionFromGitAsync: { name: "exportSolutionFromGitAsync", change: "create" },
  "solution.ExportTranslation": { name: "exportTranslation", change: "read" },
  ExtractKeyPhrases: { name: "extractKeyPhrases", change: "read" },
  ExtractTextEntities: { name: "extractTextEntities", change: "read" },
  FetchXmlToQueryExpression: { name: "fetchXmlToQueryExpression" },
  FormatAddress: { name: "formatAddress" },
  FormPredict: { name: "formPredict", change: "read" },
  FullTextSearchKnowledgeArticle: { name: "fullTextSearchKnowledgeArticle", change: "read" },
  GenerateAutomatedPlugin: { name: "generateAutomatedPlugin", change: "create" },
  GenerateInstantPlugin: { name: "generateInstantPlugin", change: "create" },
  GeneratePowerFxFormula: { name: "generatePowerFxFormula", change: "create" },
  GenerateSharedLink: { name: "generateSharedLink", change: "update" },
  "socialprofile.GenerateSocialProfile": { name: "generateSocialProfile", change: "create" },
  "timezonedefinition.GetAllTimeZonesWithDisplayName": { name: "getAllTimeZonesWithDisplayName" },
  GetAuditStorageDetails: { name: "getAuditStorageDetails", change: "read" },
  GetAutoNumberSeed: { name: "getAutoNumberSeed", change: "read" },
  GetCertificateCredential: { name: "getCertificateCredential", change: "read" },
  GetComponentManagedIdentityFIC: { name: "getComponentManagedIdentityFIC" },
  "connectioninstance.GetConsentLink": { name: "getConsentLink", change: "read" },
  "importfile.GetDistinctValuesImportFile": { name: "getDistinctValuesImportFile" },
  GetEntitiesEligibleForRecycleBin: { name: "getEntitiesEligibleForRecycleBin", change: "read" },
  GetEntityLinkChatConfig: { name: "getEntityLinkChatConfig", change: "read" },
  GetFeatureControlStringSettingsForNamespaceWithUserContext: {
    name: "getFeatureControlStringSettingsForNamespaceWithUserContext",
    change: "read",
  },
  GetFileSasUrl: { name: "getFileSasUrl" },
  GetFileSasUrlForUpload: { name: "getFileSasUrlForUpload" },
  "importfile.GetHeaderColumnsImportFile": { name: "getHeaderColumnsImportFile" },
  GetHostedRpaCapacity: { name: "getHostedRpaCapacity" },
  GetJobStatus: { name: "getJobStatus", change: "read" },
  GetLinkedChats: { name: "getLinkedChats", change: "read" },
  GetNextAutoNumberValue: { name: "getNextAutoNumberValue", change: "update" },
  "flowtrigger.GetNextRuns": { name: "getNextRuns" },
  "flowtrigger.GetNextRunsForFlowTrigger": { name: "getNextRunsForFlowTrigger" },
  GetOrCreateSharedWorkspace: { name: "getOrCreateSharedWorkspace", change: "create" },
  GetPBIReportRefreshStatus: { name: "getPBIReportRefreshStatus", change: "read" },
  GetPluginCertificateInfo: { name: "getPluginCertificateInfo" },
  GetPreferredSolution: { name: "getPreferredSolution" },
  "flowmachinegroup.GetPublicKey": { name: "getPublicKey", change: "read" },
  "report.GetReportHistoryLimit": { name: "getReportHistoryLimit" },
  "businessprocess.GetRunMap": { name: "getRunMap", change: "read" },
  GetSearchInformation: { name: "getSearchInformation" },
  GetTimeZoneCodeByLocalizedName: { name: "getTimeZoneCodeByLocalizedName" },
  GetTrackingTokenEmail: { name: "getTrackingTokenEmail", change: "read" },
  GetValidManyToMany: { name: "getValidManyToMany" },
  GetValidReferencedEntities: { name: "getValidReferencedEntities" },
  GetValidReferencingEntities: { name: "getValidReferencingEntities" },
  GetWorkIQTaskStatus: { name: "getWorkIQTaskStatus", change: "read" },
  GrantAccess: { name: "grantAccess", change: "update" },
  GrantAccessUsingSharedLink: { name: "grantAccessUsingSharedLink", change: "update" },
  GrantDelegatedAccess: { name: "grantDelegatedAccess", change: "update" },
  ImmediateBook: { name: "immediateBook", change: "update" },
  ImportCardTypeSchema: { name: "importCardTypeSchema", change: "update" },
  ImportFieldTranslation: { name: "importFieldTranslation", change: "update" },
  ImportMappingsImportMap: { name: "importMappingsImportMap", change: "update" },
  "import.ImportRecordsImport": { name: "importRecordsImport", change: "update" },
  ImportSolution: { name: "importSolution", change: "update" },
  ImportSolutionAsync: { name: "importSolutionAsync", change: "update" },
  ImportSolutions: { name: "importSolutions", change: "update" },
  ImportTranslation: { name: "importTranslation", change: "update" },
  ImportTranslationAsync: { name: "importTranslationAsync", change: "update" },
  IncrementKnowledgeArticleViewCount: {
    name: "incrementKnowledgeArticleViewCount",
    change: "update",
  },
  InferEntityDefinition: { name: "inferEntityDefinition", change: "read" },
  InitializeAnnotationBlocksDownload: {
    name: "initializeAnnotationBlocksDownload",
    change: "read",
  },
  InitializeAnnotationBlocksUpload: { name: "initializeAnnotationBlocksUpload", change: "create" },
  InitializeAttachmentBlocksDownload: {
    name: "initializeAttachmentBlocksDownload",
    change: "read",
  },
  InitializeAttachmentBlocksUpload: { name: "initializeAttachmentBlocksUpload", change: "create" },
  InitializeFileBlocksDownload: { name: "initializeFileBlocksDownload", change: "read" },
  InitializeFileBlocksUpload: { name: "initializeFileBlocksUpload", change: "create" },
  InitializeFrom: { name: "initializeFrom" },
  "workflow.InitializeModernFlowFromAsyncWorkflow": {
    name: "initializeModernFlowFromAsyncWorkflow",
    change: "create",
  },
  InitializeTemporaryFileBlocksUpload: {
    name: "initializeTemporaryFileBlocksUpload",
    change: "create",
  },
  InsertOptionValue: { name: "insertOptionValue", change: "update" },
  InsertStatusValue: { name: "insertStatusValue", change: "update" },
  InstallSampleData: { name: "installSampleData", change: "create" },
  "systemuser.InstantiateFilters": { name: "instantiateFilters", change: "create" },
  InstantiateTemplate: { name: "instantiateTemplate", change: "read" },
  IsCDS3Ready: { name: "isCDS3Ready" },
  IsComponentCustomizable: { name: "isComponentCustomizable" },
  IsDataEncryptionActive: { name: "isDataEncryptionActive" },
  IsPaiEnabled: { name: "isPaiEnabled", change: "read" },
  IsPmEnabled: { name: "isPmEnabled", change: "read" },
  IsValidStateTransition: { name: "isValidStateTransition" },
  JoinLinkedChat: { name: "joinLinkedChat", change: "update" },
  "flowmachine.LeaveGroup": { name: "leaveGroup", change: "delete" },
  "workflow.ListChildDesktopFlows": { name: "listChildDesktopFlows", change: "read" },
  "workflow.ListConnectionReferences": { name: "listConnectionReferences", change: "read" },
  "credential.ListCredentialDependencies": { name: "listCredentialDependencies" },
  "flowgroup.ListFlowsInFlowGroup": { name: "listFlowsInFlowGroup" },
  LocalTimeFromUtcTime: { name: "localTimeFromUtcTime" },
  McpCreateTable: { name: "mcpCreateTable", change: "create" },
  McpExecuteWorkIQTask: { name: "mcpExecuteWorkIQTask", change: "update" },
  McpGetGlobalOptionSet: { name: "mcpGetGlobalOptionSet" },
  McpGetWorkIQTaskStatus: { name: "mcpGetWorkIQTaskStatus", change: "read" },
  McpUpdateGlobalOptionSet: { name: "mcpUpdateGlobalOptionSet", change: "update" },
  McpUpdateTable: { name: "mcpUpdateTable", change: "update" },
  Merge: { name: "merge", change: "update" },
  ModifyAccess: { name: "modifyAccess", change: "update" },
  NotifyEnvironmentVariableSecretChange: {
    name: "notifyEnvironmentVariableSecretChange",
    change: "send",
  },
  OrderOption: { name: "orderOption", change: "update" },
  "import.ParseImport": { name: "parseImport", change: "update" },
  PBIAutoRefreshDataset: { name: "pBIAutoRefreshDataset", change: "update" },
  "queueitem.PickFromQueue": { name: "pickFromQueue", change: "update" },
  PowerAutomateProxy: { name: "powerAutomateProxy", change: "update" },
  PreferredSolutionUsedBy: { name: "preferredSolutionUsedBy" },
  PreValidateGitComponents: { name: "preValidateGitComponents", change: "read" },
  ProvisionDelegation: { name: "provisionDelegation", change: "update" },
  ProvisionLanguage: { name: "provisionLanguage", change: "create" },
  ProvisionLanguageAsync: { name: "provisionLanguageAsync", change: "create" },
  PublishAllXml: { name: "publishAllXml", change: "update" },
  PublishAllXmlAsync: { name: "publishAllXmlAsync", change: "update" },
  "duplicaterule.PublishDuplicateRule": { name: "publishDuplicateRule", change: "update" },
  "theme.PublishTheme": { name: "publishTheme", change: "update" },
  PublishXml: { name: "publishXml", change: "update" },
  PullChangesFromGit: { name: "pullChangesFromGit", change: "update" },
  PullChangesFromGitAsync: { name: "pullChangesFromGitAsync", change: "update" },
  PurgeRetainedContent: { name: "purgeRetainedContent", change: "delete" },
  QueryDvUnstructuredData: { name: "queryDvUnstructuredData", change: "read" },
  QueryExpressionToFetchXml: { name: "queryExpressionToFetchXml", change: "read" },
  QuerySchedule: { name: "querySchedule" },
  QuestionAnalytics: { name: "questionAnalytics", change: "read" },
  ReactivateEntityKey: { name: "reactivateEntityKey", change: "update" },
  ReassignObjectsOwner: { name: "reassignObjectsOwner", change: "update" },
  "systemuser.ReassignObjectsSystemUser": { name: "reassignObjectsSystemUser", change: "update" },
  "goal.Recalculate": { name: "recalculate", change: "update" },
  RecognizeText: { name: "recognizeText", change: "read" },
  RefreshChangesFromGit: { name: "refreshChangesFromGit", change: "update" },
  RefreshRpaLicensingCapacity: { name: "refreshRpaLicensingCapacity", change: "update" },
  RegisterFlowMachine: { name: "registerFlowMachine", change: "create" },
  "queueitem.ReleaseToQueue": { name: "releaseToQueue", change: "update" },
  RemoveActiveCustomization: { name: "removeActiveCustomization", change: "delete" },
  RemoveActiveCustomizations: { name: "removeActiveCustomizations", change: "delete" },
  RemoveAppComponents: { name: "removeAppComponents", change: "delete" },
  RemoveCertificateCredential: { name: "removeCertificateCredential", change: "delete" },
  "flowgroup.RemoveFlowFromFlowGroup": { name: "removeFlowFromFlowGroup", change: "delete" },
  "queueitem.RemoveFromQueue": { name: "removeFromQueue", change: "delete" },
  "team.RemoveMembersTeam": { name: "removeMembersTeam", change: "delete" },
  RemoveParent: { name: "removeParent", change: "delete" },
  "role.RemovePrivilegeRole": { name: "removePrivilegeRole", change: "delete" },
  RemoveSolutionComponent: { name: "removeSolutionComponent", change: "delete" },
  "systemuser.RemoveUserFromRecordTeam": { name: "removeUserFromRecordTeam", change: "delete" },
  "role.ReplacePrivilegesRole": { name: "replacePrivilegesRole", change: "update" },
  Reschedule: { name: "reschedule", change: "update" },
  ResetInheritedAccess: { name: "resetInheritedAccess", change: "update" },
  ResetUserFilters: { name: "resetUserFilters", change: "update" },
  "flowmachine.RestartHostedMachine": { name: "restartHostedMachine", change: "update" },
  Restore: { name: "restore", change: "update" },
  Retain: { name: "retain", change: "update" },
  RetrieveAadUserPrivileges: { name: "retrieveAadUserPrivileges" },
  RetrieveAadUserRoles: { name: "retrieveAadUserRoles" },
  RetrieveAadUserSetOfPrivilegesByIds: { name: "retrieveAadUserSetOfPrivilegesByIds" },
  RetrieveAadUserSetOfPrivilegesByNames: { name: "retrieveAadUserSetOfPrivilegesByNames" },
  "sharepointdocumentlocation.RetrieveAbsoluteAndSiteCollectionUrl": {
    name: "retrieveAbsoluteAndSiteCollectionUrlForSharepointdocumentlocation",
  },
  "sharepointsite.RetrieveAbsoluteAndSiteCollectionUrl": {
    name: "retrieveAbsoluteAndSiteCollectionUrlForSharepointsite",
  },
  RetrieveAccessOrigin: { name: "retrieveAccessOrigin" },
  RetrieveActivePath: { name: "retrieveActivePath" },
  "systemuser.RetrieveAllChildUsersSystemUser": { name: "retrieveAllChildUsersSystemUser" },
  RetrieveAllCompositeDataSources: { name: "retrieveAllCompositeDataSources" },
  RetrieveAllEntities: { name: "retrieveAllEntities" },
  RetrieveAnalyticsStoreDetails: { name: "retrieveAnalyticsStoreDetails" },
  RetrieveAppComponents: { name: "retrieveAppComponents" },
  RetrieveApplicationRibbon: { name: "retrieveApplicationRibbon" },
  RetrieveAppsWithDelegatedAccessPermissions: {
    name: "retrieveAppsWithDelegatedAccessPermissions",
    change: "read",
  },
  RetrieveAttributeChangeHistory: { name: "retrieveAttributeChangeHistory" },
  "audit.RetrieveAuditDetails": { name: "retrieveAuditDetails" },
  RetrieveAuditPartitionList: { name: "retrieveAuditPartitionList" },
  RetrieveAvailableLanguages: { name: "retrieveAvailableLanguages" },
  RetrieveBoolFeatureControlSetting: { name: "retrieveBoolFeatureControlSetting", change: "read" },
  "businessunit.RetrieveBusinessHierarchyBusinessUnit": {
    name: "retrieveBusinessHierarchyBusinessUnit",
  },
  "subject.RetrieveByTopIncidentSubjectKbArticle": {
    name: "retrieveByTopIncidentSubjectKbArticle",
  },
  RetrieveCascadeAssignAsyncJobId: { name: "retrieveCascadeAssignAsyncJobId" },
  RetrieveCascadeDeleteAsyncJobId: { name: "retrieveCascadeDeleteAsyncJobId" },
  RetrieveChannelAccessProfilePrivileges: { name: "retrieveChannelAccessProfilePrivileges" },
  RetrieveCompositeDataSource: { name: "retrieveCompositeDataSource" },
  RetrieveConnectorActions: { name: "retrieveConnectorActions", change: "read" },
  RetrieveConnectorSettings: { name: "retrieveConnectorSettings", change: "read" },
  RetrieveCurrentOrganization: { name: "retrieveCurrentOrganization" },
  RetrieveDataEncryptionKey: { name: "retrieveDataEncryptionKey" },
  RetrieveDependenciesForDelete: { name: "retrieveDependenciesForDelete" },
  RetrieveDependenciesForUninstall: { name: "retrieveDependenciesForUninstall" },
  RetrieveDependentComponents: { name: "retrieveDependentComponents" },
  RetrieveDeploymentLicenseType: { name: "retrieveDeploymentLicenseType" },
  RetrieveDeprovisionedLanguages: { name: "retrieveDeprovisionedLanguages" },
  RetrieveDuplicates: { name: "retrieveDuplicates" },
  RetrieveEntity: { name: "retrieveEntity" },
  RetrieveEntityRibbon: { name: "retrieveEntityRibbon" },
  RetrieveEnvironmentVariables: { name: "retrieveEnvironmentVariables" },
  RetrieveEnvironmentVariableSecretValue: {
    name: "retrieveEnvironmentVariableSecretValue",
    change: "read",
  },
  RetrieveEnvironmentVariableValue: { name: "retrieveEnvironmentVariableValue" },
  RetrieveExchangeAppointments: { name: "retrieveExchangeAppointments" },
  RetrieveExchangeRate: { name: "retrieveExchangeRate" },
  RetrieveFeatureControlSetting: { name: "retrieveFeatureControlSetting", change: "read" },
  RetrieveFeatureControlSettings: { name: "retrieveFeatureControlSettings", change: "read" },
  RetrieveFeatureControlSettingsByNamespace: {
    name: "retrieveFeatureControlSettingsByNamespace",
    change: "read",
  },
  RetrieveFeatureControlStringSettings: {
    name: "retrieveFeatureControlStringSettings",
    change: "read",
  },
  RetrieveFeatureControlStringSettingsForNamespace: {
    name: "retrieveFeatureControlStringSettingsForNamespace",
    change: "read",
  },
  "systemform.RetrieveFilteredForms": { name: "retrieveFilteredForms" },
  RetrieveFinanceAndOperationsIntegrationDetails: {
    name: "retrieveFinanceAndOperationsIntegrationDetails",
  },
  RetrieveFlowUpdates: { name: "retrieveFlowUpdates", change: "read" },
  RetrieveFormattedImportJobResults: { name: "retrieveFormattedImportJobResults" },
  RetrieveInstalledLanguagePacks: { name: "retrieveInstalledLanguagePacks" },
  RetrieveInstalledLanguagePackVersion: { name: "retrieveInstalledLanguagePackVersion" },
  RetrieveLicenseInfo: { name: "retrieveLicenseInfo" },
  RetrieveLocLabels: { name: "retrieveLocLabels" },
  RetrieveMailboxTrackingFolders: { name: "retrieveMailboxTrackingFolders" },
  RetrieveMaskedAttributesForEntity: { name: "retrieveMaskedAttributesForEntity" },
  RetrieveMetadataChanges: { name: "retrieveMetadataChanges" },
  RetrieveMissingComponents: { name: "retrieveMissingComponents" },
  RetrieveMissingDependencies: { name: "retrieveMissingDependencies" },
  RetrieveMissingDependenciesWithMetadata: { name: "retrieveMissingDependenciesWithMetadata" },
  RetrieveOrganizationInfo: { name: "retrieveOrganizationInfo" },
  RetrieveOrganizationResources: { name: "retrieveOrganizationResources" },
  RetrieveParsedDataImportFile: { name: "retrieveParsedDataImportFile" },
  "post.RetrievePersonalWall": { name: "retrievePersonalWall" },
  RetrievePowerAppsConnections: { name: "retrievePowerAppsConnections", change: "read" },
  RetrievePowerAppsConnectorApis: { name: "retrievePowerAppsConnectorApis", change: "read" },
  "organization.RetrievePrincipalAccess": { name: "retrievePrincipalAccessForOrganization" },
  "systemuser.RetrievePrincipalAccess": { name: "retrievePrincipalAccessForSystemuser" },
  "team.RetrievePrincipalAccess": { name: "retrievePrincipalAccessForTeam" },
  "systemuser.RetrievePrincipalAccessInfo": { name: "retrievePrincipalAccessInfoForSystemuser" },
  "team.RetrievePrincipalAccessInfo": { name: "retrievePrincipalAccessInfoForTeam" },
  "systemuser.RetrievePrincipalAttributePrivileges": {
    name: "retrievePrincipalAttributePrivilegesForSystemuser",
  },
  "team.RetrievePrincipalAttributePrivileges": {
    name: "retrievePrincipalAttributePrivilegesForTeam",
  },
  "systemuser.RetrievePrincipalSyncAttributeMappings": {
    name: "retrievePrincipalSyncAttributeMappingsForSystemuser",
  },
  "team.RetrievePrincipalSyncAttributeMappings": {
    name: "retrievePrincipalSyncAttributeMappingsForTeam",
  },
  "privilege.RetrievePrivilegeSet": { name: "retrievePrivilegeSet" },
  RetrieveProcessInstances: { name: "retrieveProcessInstances" },
  RetrieveProvisionedLanguagePackVersion: { name: "retrieveProvisionedLanguagePackVersion" },
  RetrieveProvisionedLanguages: { name: "retrieveProvisionedLanguages" },
  RetrieveRecordChangeHistory: { name: "retrieveRecordChangeHistory" },
  "post.RetrieveRecordWall": { name: "retrieveRecordWall" },
  RetrieveRequiredComponents: { name: "retrieveRequiredComponents" },
  RetrieveRolePrivilegesRole: { name: "retrieveRolePrivilegesRole" },
  RetrieveSetting: { name: "retrieveSetting" },
  RetrieveSharedLinks: { name: "retrieveSharedLinks" },
  RetrieveSharedPrincipalsAndAccess: { name: "retrieveSharedPrincipalsAndAccess" },
  "team.RetrieveTeamPrivileges": { name: "retrieveTeamPrivileges" },
  "activitypointer.RetrieveTimelineWallRecords": { name: "retrieveTimelineWallRecords" },
  RetrieveTimestamp: { name: "retrieveTimestamp" },
  RetrieveTotalRecordCount: { name: "retrieveTotalRecordCount" },
  "aiplugin.RetrieveUnpublished": { name: "retrieveUnpublishedForAiplugin" },
  "aipluginconversationstarter.RetrieveUnpublished": {
    name: "retrieveUnpublishedForAipluginconversationstarter",
  },
  "aipluginconversationstartermapping.RetrieveUnpublished": {
    name: "retrieveUnpublishedForAipluginconversationstartermapping",
  },
  "aipluginoperation.RetrieveUnpublished": { name: "retrieveUnpublishedForAipluginoperation" },
  "aipluginoperationparameter.RetrieveUnpublished": {
    name: "retrieveUnpublishedForAipluginoperationparameter",
  },
  "aipluginoperationresponsetemplate.RetrieveUnpublished": {
    name: "retrieveUnpublishedForAipluginoperationresponsetemplate",
  },
  "aiplugintitle.RetrieveUnpublished": { name: "retrieveUnpublishedForAiplugintitle" },
  "appconfig.RetrieveUnpublished": { name: "retrieveUnpublishedForAppconfig" },
  "appconfiginstance.RetrieveUnpublished": { name: "retrieveUnpublishedForAppconfiginstance" },
  "appmodule.RetrieveUnpublished": { name: "retrieveUnpublishedForAppmodule" },
  "computeruseagent.RetrieveUnpublished": { name: "retrieveUnpublishedForComputeruseagent" },
  "customcontroldefaultconfig.RetrieveUnpublished": {
    name: "retrieveUnpublishedForCustomcontroldefaultconfig",
  },
  "desktopflowbinary.RetrieveUnpublished": { name: "retrieveUnpublishedForDesktopflowbinary" },
  "mobileofflineprofile.RetrieveUnpublished": {
    name: "retrieveUnpublishedForMobileofflineprofile",
  },
  "mobileofflineprofileitem.RetrieveUnpublished": {
    name: "retrieveUnpublishedForMobileofflineprofileitem",
  },
  "navigationsetting.RetrieveUnpublished": { name: "retrieveUnpublishedForNavigationsetting" },
  "savedquery.RetrieveUnpublished": { name: "retrieveUnpublishedForSavedquery" },
  "savedqueryvisualization.RetrieveUnpublished": {
    name: "retrieveUnpublishedForSavedqueryvisualization",
  },
  "sitemap.RetrieveUnpublished": { name: "retrieveUnpublishedForSitemap" },
  "systemform.RetrieveUnpublished": { name: "retrieveUnpublishedForSystemform" },
  "webresource.RetrieveUnpublished": { name: "retrieveUnpublishedForWebresource" },
  "workflow.RetrieveUnpublished": { name: "retrieveUnpublishedForWorkflow" },
  "aiplugin.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForAiplugin" },
  "aipluginconversationstarter.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForAipluginconversationstarter",
  },
  "aipluginconversationstartermapping.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForAipluginconversationstartermapping",
  },
  "aipluginoperation.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForAipluginoperation",
  },
  "aipluginoperationparameter.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForAipluginoperationparameter",
  },
  "aipluginoperationresponsetemplate.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForAipluginoperationresponsetemplate",
  },
  "aiplugintitle.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForAiplugintitle",
  },
  "appconfig.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForAppconfig" },
  "appconfiginstance.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForAppconfiginstance",
  },
  "appmodule.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForAppmodule" },
  "computeruseagent.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForComputeruseagent",
  },
  "customcontroldefaultconfig.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForCustomcontroldefaultconfig",
  },
  "desktopflowbinary.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForDesktopflowbinary",
  },
  "mobileofflineprofile.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForMobileofflineprofile",
  },
  "mobileofflineprofileitem.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForMobileofflineprofileitem",
  },
  "navigationsetting.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForNavigationsetting",
  },
  "savedquery.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForSavedquery" },
  "savedqueryvisualization.RetrieveUnpublishedMultiple": {
    name: "retrieveUnpublishedMultipleForSavedqueryvisualization",
  },
  "sitemap.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForSitemap" },
  "systemform.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForSystemform" },
  "webresource.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForWebresource" },
  "workflow.RetrieveUnpublishedMultiple": { name: "retrieveUnpublishedMultipleForWorkflow" },
  "systemuser.RetrieveUserApplicationLicenseAccess": {
    name: "retrieveUserApplicationLicenseAccess",
  },
  "systemuser.RetrieveUserLicenseInfo": { name: "retrieveUserLicenseInfo" },
  "systemuser.RetrieveUserPrivilegeByPrivilegeId": { name: "retrieveUserPrivilegeByPrivilegeId" },
  "systemuser.RetrieveUserPrivilegeByPrivilegeName": {
    name: "retrieveUserPrivilegeByPrivilegeName",
  },
  "systemuser.RetrieveUserPrivileges": { name: "retrieveUserPrivileges" },
  "systemuser.RetrieveUserQueues": { name: "retrieveUserQueues" },
  "systemuser.RetrieveUserSetOfPrivilegesByIds": { name: "retrieveUserSetOfPrivilegesByIds" },
  "systemuser.RetrieveUserSetOfPrivilegesByNames": { name: "retrieveUserSetOfPrivilegesByNames" },
  "systemuser.RetrieveUsersPrivilegesThroughTeams": { name: "retrieveUsersPrivilegesThroughTeams" },
  RetrieveVersion: { name: "retrieveVersion" },
  RevokeAccess: { name: "revokeAccess", change: "delete" },
  RevokeSharedLink: { name: "revokeSharedLink", change: "delete" },
  RollbackRetain: { name: "rollbackRetain", change: "delete" },
  Rollup: { name: "rollup" },
  "flowmachinegroup.RotateGroupKey": { name: "rotateGroupKey", change: "update" },
  RouteTo: { name: "routeTo", change: "update" },
  RunDataProcessingModule: { name: "runDataProcessingModule", change: "update" },
  "workflow.RunDesktopFlow": { name: "runDesktopFlow", change: "update" },
  "workflow.SaveAsDesktopFlow": { name: "saveAsDesktopFlow", change: "create" },
  "desktopflowmodule.SaveAsDesktopFlowModule": {
    name: "saveAsDesktopFlowModule",
    change: "create",
  },
  SaveSettingValue: { name: "saveSettingValue", change: "update" },
  Search: { name: "search" },
  searchautocomplete: { name: "searchautocomplete", change: "read" },
  "kbarticle.SearchByBodyKbArticle": { name: "searchByBodyKbArticle" },
  "kbarticle.SearchByKeywordsKbArticle": { name: "searchByKeywordsKbArticle" },
  "kbarticle.SearchByTitleKbArticle": { name: "searchByTitleKbArticle" },
  searchquery: { name: "searchquery", change: "read" },
  searchstatistics: { name: "searchstatistics" },
  searchstatus: { name: "searchstatus" },
  searchsuggest: { name: "searchsuggest", change: "read" },
  SendAppNotification: { name: "sendAppNotification", change: "send" },
  SendBulkMail: { name: "sendBulkMail", change: "send" },
  "email.SendEmail": { name: "sendEmail", change: "send" },
  SendEmailFromTemplate: { name: "sendEmailFromTemplate", change: "send" },
  SendFax: { name: "sendFax", change: "send" },
  SendTemplate: { name: "sendTemplate", change: "send" },
  SetAutoNumberSeed: { name: "setAutoNumberSeed", change: "update" },
  "systemuser.SetBusinessSystemUser": { name: "setBusinessSystemUser", change: "update" },
  SetDataEncryptionKey: { name: "setDataEncryptionKey", change: "update" },
  SetFeatureStatus: { name: "setFeatureStatus", change: "update" },
  SetLocLabels: { name: "setLocLabels", change: "update" },
  "systemuser.SetParentSystemUser": { name: "setParentSystemUser", change: "update" },
  "team.SetParentTeam": { name: "setParentTeam", change: "update" },
  SetPreferredSolution: { name: "setPreferredSolution", change: "update" },
  SetProcess: { name: "setProcess", change: "update" },
  SetReportRelated: { name: "setReportRelated", change: "update" },
  SetupAiConnection: { name: "setupAiConnection", change: "update" },
  SnapshotDatasource: { name: "snapshotDatasource", change: "update" },
  StageAndUpgrade: { name: "stageAndUpgrade", change: "update" },
  StageAndUpgradeAsync: { name: "stageAndUpgradeAsync", change: "update" },
  StageSolution: { name: "stageSolution", change: "create" },
  SubstituteForAttribute: { name: "substituteForAttribute", change: "update" },
  SubstituteForComponent: { name: "substituteForComponent", change: "update" },
  SummarizeRecord: { name: "summarizeRecord", change: "read" },
  SyncBulkOperation: { name: "syncBulkOperation", change: "update" },
  SyncCopresenceState: { name: "syncCopresenceState", change: "update" },
  "team.SyncGroupMembersToTeam": { name: "syncGroupMembersToTeam", change: "update" },
  TransformImport: { name: "transformImport", change: "update" },
  "serviceendpoint.TriggerServiceEndpointCheck": {
    name: "triggerServiceEndpointCheck",
    change: "update",
  },
  UninstallSampleData: { name: "uninstallSampleData", change: "delete" },
  UninstallSolution: { name: "uninstallSolution", change: "delete" },
  UninstallSolutionAsync: { name: "uninstallSolutionAsync", change: "delete" },
  UnpublishDuplicateRule: { name: "unpublishDuplicateRule", change: "update" },
  "flowmachinegroup.UpdateAccountCredentials": {
    name: "updateAccountCredentials",
    change: "update",
  },
  UpdateAutomatedPlugin: { name: "updateAutomatedPlugin", change: "update" },
  UpdateFeatureConfig: { name: "updateFeatureConfig", change: "update" },
  "flowmachinenetwork.UpdateFlowMachineNetwork": {
    name: "updateFlowMachineNetwork",
    change: "update",
  },
  UpdateInstantPlugin: { name: "updateInstantPlugin", change: "update" },
  "crmbaseentity.UpdateMultiple": { name: "updateMultiple", change: "update" },
  UpdateOptionValue: { name: "updateOptionValue", change: "update" },
  UpdateRibbonClientMetadata: { name: "updateRibbonClientMetadata", change: "update" },
  UpdateSolutionComponent: { name: "updateSolutionComponent", change: "update" },
  UpdateStateValue: { name: "updateStateValue", change: "update" },
  UploadBlock: { name: "uploadBlock", change: "create" },
  UpsertCompositeDataSource: { name: "upsertCompositeDataSource", change: "update" },
  UpsertEnvironmentVariable: { name: "upsertEnvironmentVariable", change: "update" },
  "crmbaseentity.UpsertMultiple": { name: "upsertMultiple", change: "update" },
  Validate: { name: "validate", change: "read" },
  ValidateAIConfiguration: { name: "validateAIConfiguration", change: "read" },
  ValidateApp: { name: "validateApp" },
  ValidateFetchXmlExpression: { name: "validateFetchXmlExpression" },
  ValidateRecurrenceRule: { name: "validateRecurrenceRule" },
  ValidateRetentionConfig: { name: "validateRetentionConfig", change: "read" },
  "savedquery.ValidateSavedQuery": { name: "validateSavedQuery", change: "read" },
  ValidateUnpublished: { name: "validateUnpublished", change: "read" },
  WhoAmI: { name: "whoAmI" },
} as const;

type Rule = {
  name: string;
  change?: string;
  headers?: Record<string, { name: string; description: string }>;
  parameters?: readonly object[];
};

// Every method can act for another user and take OData's preferences; reads
// can skip caches, and changes can skip business logic and tag their plug-ins.
export const operations = Object.fromEntries(
  Object.entries(offered).map(([id, value]): [string, Rule] => {
    const rule: Rule = value;
    const changes = rule.change !== undefined && rule.change !== "read";

    return [
      id,
      {
        ...rule,
        headers: {
          ...prefer,
          ...(changes ? bypass : consistency),
          ...rule.headers,
          ...impersonation,
        },
        parameters: [...(rule.parameters ?? []), ...(changes ? [tag] : [])],
      },
    ];
  }),
);
